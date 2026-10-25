// CANDLESTICK PATTERN PRACTICE — 1-MINUTE BTCUSD
//
// Goal: measure, honestly, how well classic candlestick patterns work as
// standalone signals on the 1m bar, and then "sharpen" them with context
// filters until what is left is either a real edge or a clear NO.
//
// Pipeline (no look-ahead anywhere: a pattern seen on bar i is acted on from
// the OPEN of bar i+1):
//
//   PHASE 1 — DETECT. A library of single/two/three-bar patterns graded with
//     simple, objective geometry (body vs range, wick ratios, engulf rules).
//   PHASE 2 — RAW EDGE. For every signal, the forward return in the pattern's
//     supposed direction at several horizons, in BOTH bps and ATR units. This
//     is the pure signal: does the pattern actually tilt the next move?
//   PHASE 3 — TRADE IT. ATR stop + fixed-R target with real Delta costs so we
//     see what survives after fees (the known killer on 1m).
//   PHASE 4 — SHARPEN. Re-grade every pattern under context filters (trend,
//     regime, volatility, volume, location at a swing extreme) and report the
//     best trustworthy combination per pattern.
//
//   node backtest/research-candles-1m.js
//   node backtest/research-candles-1m.js --days 14 --nofee
//   node backtest/research-candles-1m.js --stopAtr 1.5 --targetR 1.5
'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const TF = '1m';

// Real Delta perp schedule; --nofee zeroes it to expose the raw edge.
const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

const CFG = {
  contractValue: 0.001,
  feeMaker: REAL.maker,
  feeTaker: REAL.taker,
  slippage: REAL.slip,
  initialEquity: 1200,
  riskPct: 0.005,
  maxNotionalPct: 20, // perp-style leverage cap; riskPct is the binding constraint
};

const P = {
  atrPeriod: 14,
  bodyAvgPeriod: 20,
  trendFast: 20,
  trendSlow: 200,
  erPeriod: 10,
  volWindow: 240,
  swingLookback: 20,
  stopAtr: 1.0,
  targetR: 1.0,
  holdBars: 20,
  horizons: [5, 15, 30],
};

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
// PHASE 1 — pattern library
// ---------------------------------------------------------------------------

function geom(c) {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(1e-9, c.high - c.low);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const bull = c.close >= c.open;
  return { body, range, upper, lower, bull, bodyFrac: body / range, mid: (c.high + c.low) / 2 };
}

// Returns, for bar i, the list of patterns that complete ON bar i.
// `dir` = the direction the pattern is supposed to forecast.
function detectAt(candles, i, avgBody, avgRange) {
  const found = [];
  if (i < 3) return found;
  const c = candles[i];
  const p1 = candles[i - 1];
  const p2 = candles[i - 2];
  const g = geom(c);
  const g1 = geom(p1);
  const g2 = geom(p2);

  const bigBody = g.body >= avgBody[i] * 1.2;
  const smallBody = g.body <= avgBody[i] * 0.6;

  // --- single-bar momentum / rejection -----------------------------------
  if (g.bull && bigBody && g.bodyFrac >= 0.7) found.push({ name: 'bullMarubozu', dir: 1 });
  if (!g.bull && bigBody && g.bodyFrac >= 0.7) found.push({ name: 'bearMarubozu', dir: -1 });

  // pin bars: long rejection wick, small opposite wick
  if (g.lower >= g.body * 2 && g.lower >= g.range * 0.5 && g.upper <= g.range * 0.2) {
    found.push({ name: 'hammer', dir: 1 });
  }
  if (g.upper >= g.body * 2 && g.upper >= g.range * 0.5 && g.lower <= g.range * 0.2) {
    found.push({ name: 'shootingStar', dir: -1 });
  }
  if (g.bodyFrac <= 0.1 && g.range >= avgRange[i] * 0.5) found.push({ name: 'doji', dir: 0 });

  // --- two-bar reversals --------------------------------------------------
  if (g1.bull === false && g.bull && c.open <= p1.close && c.close >= p1.open && bigBody) {
    found.push({ name: 'bullEngulf', dir: 1 });
  }
  if (g1.bull === true && !g.bull && c.open >= p1.close && c.close <= p1.open && bigBody) {
    found.push({ name: 'bearEngulf', dir: -1 });
  }
  // harami: current (small) body contained inside the previous body
  const insidePrev =
    Math.max(c.open, c.close) <= Math.max(p1.open, p1.close) &&
    Math.min(c.open, c.close) >= Math.min(p1.open, p1.close);
  if (!g1.bull && g1.body >= avgBody[i] && smallBody && insidePrev) {
    found.push({ name: 'bullHarami', dir: 1 });
  }
  if (g1.bull && g1.body >= avgBody[i] && smallBody && insidePrev) {
    found.push({ name: 'bearHarami', dir: -1 });
  }
  // tweezers: matching lows/highs
  if (Math.abs(c.low - p1.low) <= avgRange[i] * 0.05 && g.bull && !g1.bull) {
    found.push({ name: 'tweezerBottom', dir: 1 });
  }
  if (Math.abs(c.high - p1.high) <= avgRange[i] * 0.05 && !g.bull && g1.bull) {
    found.push({ name: 'tweezerTop', dir: -1 });
  }

  // --- three-bar reversals -----------------------------------------------
  if (!g2.bull && g2.body >= avgBody[i] * 1.0 && smallBody && g.bull && c.close > (p2.open + p2.close) / 2) {
    found.push({ name: 'morningStar', dir: 1 });
  }
  if (g2.bull && g2.body >= avgBody[i] * 1.0 && smallBody && !g.bull && c.close < (p2.open + p2.close) / 2) {
    found.push({ name: 'eveningStar', dir: -1 });
  }
  if (g2.bull && g1.bull && g.bull && c.close > p1.close && p1.close > p2.close) {
    found.push({ name: 'threeWhiteSoldiers', dir: 1 });
  }
  if (!g2.bull && !g1.bull && !g.bull && c.close < p1.close && p1.close < p2.close) {
    found.push({ name: 'threeBlackCrows', dir: -1 });
  }

  return found;
}

function detectAll(candles, atrArr) {
  const n = candles.length;
  const bodies = candles.map((c) => Math.abs(c.close - c.open));
  const ranges = candles.map((c) => c.high - c.low);
  const avgBody = sma(bodies, P.bodyAvgPeriod);
  const avgRange = sma(ranges, P.bodyAvgPeriod);
  const signals = [];
  for (let i = P.bodyAvgPeriod + 3; i < n - 1; i += 1) {
    if (!avgBody[i] || !avgRange[i] || !atrArr[i]) continue;
    for (const pat of detectAt(candles, i, avgBody, avgRange)) {
      signals.push({ i, name: pat.name, dir: pat.dir, time: candles[i].time });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// PHASE 2 — raw forward edge (no costs)
// ---------------------------------------------------------------------------

function forwardStats(candles, atrArr, signals, horizon) {
  const out = new Map();
  for (const s of signals) {
    if (s.dir === 0) continue;
    const entry = candles[s.i + 1].open;
    const a = atrArr[s.i] || 1;
    const j = Math.min(candles.length - 1, s.i + horizon);
    const ret = (candles[j].close - entry) * s.dir;
    const b = out.get(s.name) || { n: 0, win: 0, sumAtr: 0, sumBps: 0 };
    b.n += 1;
    b.win += ret > 0 ? 1 : 0;
    b.sumAtr += ret / a;
    b.sumBps += (ret / entry) * 1e4;
    out.set(s.name, b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHASE 3 — trade simulation with costs
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (dist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

// One signal -> one trade. The pattern only fires a setup; the exit is a plain
// ATR stop + fixed-R target so every pattern is judged on the same terms.
// `opts` lets the sweep vary stop width / R multiple without touching P.
function runTrades(candles, atrArr, signals, opts = {}) {
  const stopAtr = opts.stopAtr ?? P.stopAtr;
  const targetR = opts.targetR ?? P.targetR;
  const holdBars = opts.holdBars ?? P.holdBars;
  const trades = [];
  for (const s of signals) {
    if (s.dir === 0) continue;
    const a = atrArr[s.i];
    if (!a) continue;
    const entryBar = s.i + 1;
    const entry = candles[entryBar].open;
    const stop = entry - s.dir * stopAtr * a;
    const target = entry + s.dir * targetR * stopAtr * a;
    const contracts = sizeContracts(entry, stop);
    if (!(contracts > 0)) continue;

    const riskAmount = Math.abs(entry - stop) * contracts * CFG.contractValue;
    const entryNotional = entry * contracts * CFG.contractValue;
    const entryFee = entryNotional * CFG.feeTaker + entryNotional * CFG.slippage;

    const end = Math.min(candles.length - 1, entryBar + holdBars);
    let exitPrice = candles[end].close;
    let exitFee = exitPrice * contracts * CFG.contractValue * CFG.feeTaker +
      exitPrice * contracts * CFG.contractValue * CFG.slippage;
    for (let m = entryBar; m <= end; m += 1) {
      const hitStop = s.dir === 1 ? candles[m].low <= stop : candles[m].high >= stop;
      const hitTarget = s.dir === 1 ? candles[m].high >= target : candles[m].low <= target;
      if (hitStop) {
        exitPrice = stop;
        exitFee = exitPrice * contracts * CFG.contractValue * CFG.feeTaker +
          exitPrice * contracts * CFG.contractValue * CFG.slippage;
        break;
      }
      if (hitTarget) {
        exitPrice = target;
        // resting target fills as maker
        exitFee = exitPrice * contracts * CFG.contractValue * CFG.feeMaker;
        break;
      }
    }
    const gross = (exitPrice - entry) * s.dir * contracts * CFG.contractValue;
    const fees = entryFee + exitFee;
    trades.push({
      pattern: s.name,
      dir: s.dir,
      net: gross - fees,
      gross,
      fees,
      risk: riskAmount,
      r: (gross - fees) / Math.max(1e-9, riskAmount),
      entryTime: candles[entryBar].time,
    });
  }
  return trades;
}

// ---------------------------------------------------------------------------
// PHASE 4 — context filters ("sharpening")
// ---------------------------------------------------------------------------

function contextFor(candles, atrArr, erArr, emaFast, emaSlow, volAvg, i) {
  const bar = candles[i];
  const a = atrArr[i] || 1;
  const win = candles.slice(Math.max(0, i - P.swingLookback + 1), i + 1);
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  const trendUp = emaSlow[i] !== null && bar.close > emaSlow[i];
  const fastUp = emaFast[i] !== null && bar.close > emaFast[i];
  return {
    trendUp,
    fastUp,
    er: erArr[i],
    atrPct: a / bar.close,
    volRatio: volAvg[i] ? bar.volume / volAvg[i] : 1,
    atHigh: bar.high >= hi - 1e-9,
    atLow: bar.low <= lo + 1e-9,
    rangeAtr: (bar.high - bar.low) / a,
    stretchAtr: emaFast[i] !== null ? Math.abs(bar.close - emaFast[i]) / a : 0,
  };
}

// Direction-aware context agreement: a bullish reversal wants to fire at a
// swing LOW in an uptrend / ranging tape; a bearish one at a swing HIGH.
function agree(sig, ctx) {
  const wantUp = sig.dir === 1;
  const location = wantUp ? ctx.atLow : ctx.atHigh;
  const trendAligned = wantUp ? ctx.trendUp : !ctx.trendUp;
  const fastAligned = wantUp ? ctx.fastUp : !ctx.fastUp;
  return { location, trendAligned, fastAligned };
}

// ---------------------------------------------------------------------------
// stats + reporting
// ---------------------------------------------------------------------------

function dayKey(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function summarise(trades) {
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  const gp = trades.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(trades.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const ggp = trades.filter((t) => t.gross > 0).reduce((s, t) => s + t.gross, 0);
  const ggl = Math.abs(trades.filter((t) => t.gross <= 0).reduce((s, t) => s + t.gross, 0));
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const byDay = new Map();
  for (const t of trades) byDay.set(dayKey(t.entryTime), (byDay.get(dayKey(t.entryTime)) || 0) + t.net);
  return {
    n,
    net,
    gross: net + fees,
    fees,
    wr: n ? (trades.filter((t) => t.net > 0).length / n) * 100 : 0,
    gwr: n ? (trades.filter((t) => t.gross > 0).length / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    gpf: ggl > 0 ? ggp / ggl : ggp > 0 ? Infinity : 0,
    avgR: n ? trades.reduce((s, t) => s + t.r, 0) / n : 0,
    grossR: n ? trades.reduce((s, t) => s + t.gross / Math.max(1e-9, t.risk), 0) / n : 0,
    green: [...byDay.values()].filter((v) => v > 0).length,
    days: byDay.size || 1,
  };
}

function fmt(x, d = 2) {
  return Number.isFinite(x) ? x.toFixed(d) : 'inf';
}
function pad(t, w, right = false) {
  const s = String(t);
  return right ? s.padStart(w) : s.padEnd(w);
}

function parseArgs(argv) {
  const a = { days: 0, nofee: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--nofee') a.nofee = true;
    else if (argv[i] === '--stopAtr') P.stopAtr = Number(argv[++i]);
    else if (argv[i] === '--targetR') P.targetR = Number(argv[++i]);
    else if (argv[i] === '--hold') P.holdBars = Number(argv[++i]);
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

  const cached = loadCache(SYMBOL, TF);
  if (!cached) throw new Error(`No ${TF} cache. Run: node backtest/fetch.js --symbol ${SYMBOL} --timeframes ${TF}`);

  const all = cached.candles;
  const cutoff = args.days > 0 ? all[all.length - 1].time - args.days * 86400 : all[0].time;
  const candles = all;
  const n = candles.length;

  const atrArr = atr(candles, P.atrPeriod);
  const erArr = erSeries(candles, P.erPeriod);
  const emaFast = ema(candles.map((c) => c.close), P.trendFast);
  const emaSlow = ema(candles.map((c) => c.close), P.trendSlow);
  const volAvg = sma(candles.map((c) => c.volume), P.volWindow);

  const signalsAll = detectAll(candles, atrArr);
  const signals = signalsAll.filter((s) => s.time >= cutoff);

  const first = dayKey(candles[0].time);
  const last = dayKey(candles[n - 1].time);
  console.log('============================================================');
  console.log(
    ` CANDLESTICK PATTERN PRACTICE — ${SYMBOL} ${TF}   data ${first} -> ${last}  (${n} bars)   report: last ${args.days || 'all'}d`
  );
  console.log(
    ` costs  maker ${(CFG.feeMaker * 1e4).toFixed(1)}bps / taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + ` +
      `${(CFG.slippage * 1e4).toFixed(1)}bps slip${args.nofee ? '   [ZERO-COST MODE]' : ''}`
  );
  console.log(
    ` trade  stop ${P.stopAtr}ATR  target ${P.targetR}R  hold ${P.holdBars} bars  (enter next open)`
  );
  console.log('============================================================');

  const names = [...new Set(signals.filter((s) => s.dir !== 0).map((s) => s.name))].sort();

  // Attach context to every signal once (used by the sweeps below).
  const enriched = signals.map((s) => ({
    ...s,
    ctx: contextFor(candles, atrArr, erArr, emaFast, emaSlow, volAvg, s.i),
  }));

  // ---- PHASE 0 — the cost reality check ----------------------------------
  // A stop is only as good as its distance vs the round-trip cost. This is the
  // single number that decides whether ANY 1m pattern can be traded.
  const atrBps = [];
  for (let i = P.atrPeriod + 1; i < n; i += 1) {
    if (atrArr[i] && candles[i].close > 0) atrBps.push((atrArr[i] / candles[i].close) * 1e4);
  }
  atrBps.sort((a, b) => a - b);
  const medAtrBps = atrBps.length ? atrBps[Math.floor(atrBps.length / 2)] : 0;
  const roundTripBps = (CFG.feeTaker + CFG.slippage + CFG.feeMaker) * 1e4;
  console.log('\nPHASE 0 — cost reality check');
  console.log(`  median 1m ATR: ${medAtrBps.toFixed(2)} bps of price`);
  console.log(`  round-trip cost (taker in + maker out + slip): ${roundTripBps.toFixed(2)} bps`);
  console.log(
    `  => a 1-ATR stop risks ${medAtrBps.toFixed(2)} bps but pays ${roundTripBps.toFixed(2)} bps in cost ` +
      `(${(roundTripBps / medAtrBps).toFixed(2)}x the stop).` +
      (roundTripBps > 0 && roundTripBps > medAtrBps
        ? ' Any stop this tight is un-tradeable at retail fees.'
        : '')
  );

  // ---- PHASE 1 ----------------------------------------------------------
  console.log('\nPHASE 1 — patterns detected');
  console.log(`  total signals: ${signals.length}   tradable patterns: ${names.length} (+ doji as a neutral marker)`);
  const cnt = new Map();
  for (const s of signals) cnt.set(s.name, (cnt.get(s.name) || 0) + 1);
  console.log(
    '  ' + [...cnt.entries()].sort().map(([k, v]) => `${k}:${v}`).join('  ')
  );

  // ---- PHASE 2 ----------------------------------------------------------
  console.log(`\nPHASE 2 — raw forward edge in the pattern's direction (no costs)`);
  console.log(`  ${pad('pattern', 20)} | ${pad('n', 5, true)} | ${pad('h', 3, true)} | ${pad('hit%', 6, true)} | ${pad('avg bps', 8, true)} | ${pad('avg ATR', 8, true)}`);
  console.log('  ' + '-'.repeat(66));
  const rawByHorizon = new Map();
  for (const h of P.horizons) rawByHorizon.set(h, forwardStats(candles, atrArr, signals, h));
  for (const name of names) {
    for (const h of P.horizons) {
      const b = rawByHorizon.get(h).get(name);
      if (!b) continue;
      console.log(
        `  ${pad(name, 20)} | ${pad(b.n, 5, true)} | ${pad(h, 3, true)} | ${pad(((b.win / b.n) * 100).toFixed(0) + '%', 6, true)} | ` +
          `${pad((b.sumBps / b.n).toFixed(1), 8, true)} | ${pad((b.sumAtr / b.n).toFixed(3), 8, true)}`
      );
    }
  }

  // ---- PHASE 3 ----------------------------------------------------------
  const tradesAll = runTrades(candles, atrArr, signals);
  console.log('\n\nPHASE 3 — trade simulation with real costs (ATR stop + fixed-R target)');
  console.log('  (win%/PF shown GROSS — what the pattern itself does — net$ is after fees)');
  console.log(
    `  ${pad('pattern', 20)} | ${pad('n', 5, true)} | ${pad('win%', 5, true)} | ${pad('gPF', 5, true)} | ${pad('gR', 6, true)} | ${pad('gross$', 8, true)} | ${pad('fees$', 8, true)} | ${pad('net$', 9, true)}`
  );
  console.log('  ' + '-'.repeat(86));
  const tradeStats = new Map();
  for (const name of names) tradeStats.set(name, summarise(tradesAll.filter((t) => t.pattern === name)));
  for (const name of names) {
    const s = tradeStats.get(name);
    console.log(
      `  ${pad(name, 20)} | ${pad(s.n, 5, true)} | ${pad(s.gwr.toFixed(1) + '%', 5, true)} | ${pad(fmt(s.gpf), 5, true)} | ` +
        `${pad(fmt(s.grossR, 3), 6, true)} | ${pad(fmt(s.gross), 8, true)} | ${pad(fmt(s.fees), 8, true)} | ${pad(fmt(s.net), 9, true)}`
    );
  }
  const allS = summarise(tradesAll);
  console.log('  ' + '-'.repeat(86));
  console.log(
    `  ${pad('ALL PATTERNS', 20)} | ${pad(allS.n, 5, true)} | ${pad(allS.gwr.toFixed(1) + '%', 5, true)} | ${pad(fmt(allS.gpf), 5, true)} | ` +
      `${pad(fmt(allS.grossR, 3), 6, true)} | ${pad(fmt(allS.gross), 8, true)} | ${pad(fmt(allS.fees), 8, true)} | ${pad(fmt(allS.net), 9, true)}`
  );
  const avgFee = tradesAll.length ? allS.fees / tradesAll.length : 0;
  const avgRisk = tradesAll.length ? tradesAll.reduce((s, t) => s + t.risk, 0) / tradesAll.length : 0;
  console.log(
    `  avg fee per trade = $${avgFee.toFixed(3)}  vs  avg risk per trade = $${avgRisk.toFixed(3)}  ` +
      `=> fees are ${avgRisk > 0 ? (avgFee / avgRisk).toFixed(2) : 'inf'}x the risk. Break-even needs avgR >= ${avgRisk > 0 ? (avgFee / avgRisk).toFixed(2) : 'inf'}.`
  );

  // ---- PHASE 3b — stop-width sweep ---------------------------------------
  // The 1-ATR stop is un-tradeable (cost > stop). The only structural fix is a
  // WIDER stop so cost/risk falls. Sweep stop width x R on the reversal set at
  // a swing extreme and see whether ANY cell clears fees.
  const extremeRev = enriched.filter(
    (s) => agree(s, s.ctx).location && s.ctx.atrPct >= 0.0008 && s.dir !== 0
  );
  console.log('\n\nPHASE 3b — STOP-WIDTH SWEEP (reversal patterns at a 20-bar extreme + atr%>=0.08)');
  console.log(
    `  ${pad('stop', 5)} | ${pad('R', 3, true)} | ${pad('hold', 5, true)} | ${pad('n', 5, true)} | ${pad('win%', 5, true)} | ${pad('PF', 5, true)} | ${pad('avgR', 6, true)} | ${pad('cost/risk', 9, true)} | ${pad('net$', 9, true)}`
  );
  console.log('  ' + '-'.repeat(84));
  let gridBest = null;
  for (const stopAtr of [1, 2, 3, 5, 8]) {
    for (const targetR of [1, 2, 3]) {
      const hold = Math.round(20 * stopAtr);
      const tr = runTrades(candles, atrArr, extremeRev, { stopAtr, targetR, holdBars: hold });
      const st = summarise(tr);
      const costRisk = st.n ? st.fees / tr.reduce((s, t) => s + t.risk, 0) : 0;
      if (!gridBest || st.net > gridBest.st.net) gridBest = { stopAtr, targetR, hold, st };
      console.log(
        `  ${pad(stopAtr + 'ATR', 5)} | ${pad(targetR, 3, true)} | ${pad(hold, 5, true)} | ${pad(st.n, 5, true)} | ${pad(st.wr.toFixed(1) + '%', 5, true)} | ` +
          `${pad(fmt(st.pf), 5, true)} | ${pad(fmt(st.avgR, 3), 6, true)} | ${pad(costRisk.toFixed(2) + 'x', 9, true)} | ${pad(fmt(st.net), 9, true)}`
      );
    }
  }
  if (gridBest) {
    console.log(
      `  best grid cell: stop ${gridBest.stopAtr}ATR / ${gridBest.targetR}R / hold ${gridBest.hold}  ->  ` +
        `net=$${fmt(gridBest.st.net)}  win=${gridBest.st.wr.toFixed(1)}%  PF=${fmt(gridBest.st.pf)}  avgR=${fmt(gridBest.st.avgR, 3)}`
    );
  }

  // ---- PHASE 4 ----------------------------------------------------------
  // For each pattern, walk the context filters one at a time and keep whichever
  // single filter lifts expectancy the most (min sample enforced).
  const FILTERS = [
    { label: 'at swing extreme', f: (s) => agree(s, s.ctx).location },
    { label: 'trend aligned', f: (s) => agree(s, s.ctx).trendAligned },
    { label: 'fast trend aligned', f: (s) => agree(s, s.ctx).fastAligned },
    { label: 'ranging (ER<=0.45)', f: (s) => s.ctx.er !== null && s.ctx.er <= 0.45 },
    { label: 'trending (ER>=0.30)', f: (s) => s.ctx.er !== null && s.ctx.er >= 0.3 },
    { label: 'vol floor (atr%>=0.08)', f: (s) => s.ctx.atrPct >= 0.0008 },
    { label: 'vol floor (atr%>=0.12)', f: (s) => s.ctx.atrPct >= 0.0012 },
    { label: 'high volume (>=1.5x)', f: (s) => s.ctx.volRatio >= 1.5 },
    { label: 'exhaustion (range>=2ATR)', f: (s) => s.ctx.rangeAtr >= 2 },
    { label: 'stretched (>=1.5ATR)', f: (s) => s.ctx.stretchAtr >= 1.5 },
    { label: 'extreme + trend', f: (s) => agree(s, s.ctx).location && agree(s, s.ctx).trendAligned },
    { label: 'extreme + vol floor', f: (s) => agree(s, s.ctx).location && s.ctx.atrPct >= 0.0008 },
  ];

  const MIN_N = 25;
  console.log('\n\nPHASE 4 — SHARPENING: best context filter(s) per pattern (min 25 trades)');
  console.log(
    `  ${pad('pattern', 20)} | ${pad('base n', 6, true)} | ${pad('base gR', 8, true)} | ${pad('best filter', 30)} | ${pad('n', 5, true)} | ${pad('win%', 5, true)} | ${pad('gR', 6, true)} | ${pad('gPF', 5, true)} | ${pad('net$', 9, true)}`
  );
  console.log('  ' + '-'.repeat(124));
  const sharpened = [];
  for (const name of names) {
    const base = tradeStats.get(name);
    let best = null;
    // single filters
    for (const f of FILTERS) {
      const subset = enriched.filter((s) => s.name === name && f.f(s));
      if (subset.length < MIN_N) continue;
      const st = summarise(runTrades(candles, atrArr, subset));
      if (!best || st.grossR > best.st.grossR) best = { label: f.label, st, n: subset.length, fn: f.f };
    }
    // two-filter combos (context gates compound into a genuine "setup")
    for (let x = 0; x < FILTERS.length; x += 1) {
      for (let y = x + 1; y < FILTERS.length; y += 1) {
        const fx = FILTERS[x], fy = FILTERS[y];
        const fn = (s) => fx.f(s) && fy.f(s);
        const subset = enriched.filter((s) => s.name === name && fn(s));
        if (subset.length < MIN_N) continue;
        const st = summarise(runTrades(candles, atrArr, subset));
        if (!best || st.grossR > best.st.grossR) {
          best = { label: `${fx.label} + ${fy.label}`, st, n: subset.length, fn };
        }
      }
    }
    if (best) {
      sharpened.push({ name, best });
      console.log(
        `  ${pad(name, 20)} | ${pad(base.n, 6, true)} | ${pad(fmt(base.grossR, 3), 9, true)} | ${pad(best.label, 30)} | ` +
          `${pad(best.n, 5, true)} | ${pad(best.st.gwr.toFixed(1) + '%', 5, true)} | ${pad(fmt(best.st.grossR, 3), 6, true)} | ` +
          `${pad(fmt(best.st.gpf), 5, true)} | ${pad(fmt(best.st.net), 9, true)}`
      );
    }
  }

  // Confluence: strongest generic setup the practice surfaced — a reversal
  // pattern that fires AT a 20-bar extreme AND carries a volatility floor.
  const confluence = enriched.filter(
    (s) =>
      agree(s, s.ctx).location &&
      s.ctx.atrPct >= 0.0008 &&
      ['bullEngulf', 'bearEngulf', 'hammer', 'shootingStar', 'tweezerTop', 'tweezerBottom'].includes(s.name)
  );
  const cf = summarise(runTrades(candles, atrArr, confluence));
  console.log('\n  CONFLUENCE SET — engulfing / pin / tweezer @ swing extreme + atr%>=0.08');
  console.log(
    `   n=${cf.n}  win=${cf.gwr.toFixed(1)}%  grossPF=${fmt(cf.gpf)}  grossR=${fmt(cf.grossR, 3)}  ` +
      `gross=$${fmt(cf.gross)}  fees=$${fmt(cf.fees)}  net=$${fmt(cf.net)}`
  );

  // ---- PHASE 5 — verdict -------------------------------------------------
  const positiveRaw = [...tradeStats.entries()].filter(([, s]) => s.gross > 0);
  const posAfterFee = [...tradeStats.entries()].filter(([, s]) => s.net > 0 && s.n >= MIN_N);
  const sharpenedPos = sharpened.filter((x) => x.best.st.net > 0 && x.best.st.pf >= 1.1);

  // Pick the single best-sharpened combo. Ranked by GROSS edge, because with a
  // cost this large the net is uniformly negative and would just pick the
  // smallest sample; the gross edge is what the pattern work actually produced.
  const ranked = sharpened
    .map((x) => ({ ...x, st: x.best.st }))
    .filter((x) => x.best.n >= MIN_N)
    .sort((a, b) => b.st.grossR - a.st.grossR);

  console.log('\n\nPHASE 5 — verdict (what pattern work is actually worth)');
  console.log(`  patterns with positive GROSS edge (pre-fee): ${positiveRaw.length}/${names.length}`);
  console.log(`  patterns net-positive after fees (n>=${MIN_N}): ${posAfterFee.length}/${names.length}`);
  console.log(`  pattern+filter combos net-positive (PF>=1.1, n>=${MIN_N}): ${sharpenedPos.length}`);
  if (ranked.length) {
    const top = ranked[0];
    console.log(
      `  best sharpened combo (by gross edge): ${top.name} + [${top.best.label}]  ->  n=${top.best.n}  win=${top.st.gwr.toFixed(1)}%  ` +
        `grossR=${fmt(top.st.grossR, 3)}  grossPF=${fmt(top.st.gpf)}  net=$${fmt(top.st.net)}`
    );
    // Decisive comparison: the sharpest edge the practice produced, expressed in
    // the same units as the fee it must beat.
    const edgeBps = top.st.grossR * medAtrBps;
    console.log(
      `  edge vs cost: best gross edge = ${top.st.grossR.toFixed(3)} ATR ≈ ${edgeBps.toFixed(2)} bps  ` +
        `vs round-trip cost ${roundTripBps.toFixed(2)} bps  =>  ` +
        (roundTripBps > 0 ? `covers ${((edgeBps / roundTripBps) * 100).toFixed(0)}% of the cost.` : 'cost disabled.')
    );
  }
  const verdict = args.nofee
    ? `[ZERO-COST MODE] ${sharpenedPos.length} pattern+context combos show a positive RAW edge — this is the ceiling, the fee run shows how much survives.`
    : posAfterFee.length === 0 && sharpenedPos.length === 0
      ? 'NO EDGE after fees — candlestick patterns on 1m BTCUSD do not pay the spread on this window.'
      : sharpenedPos.length === 0
        ? 'PATTERNS TRADEABLE RAW but the sharable filters do not rescue them after fees.'
        : `FOUND ${sharpenedPos.length} pattern+context combos that clear fees on this window — treat as a shortlist to re-test, not a live mandate.`;
  console.log(`  => ${verdict}`);

  // daily breakdown of the best combo
  if (ranked.length) {
    const top = ranked[0];
    const subset = enriched.filter((s) => s.name === top.name && top.best.fn(s));
    const tr = runTrades(candles, atrArr, subset).filter((t) => t.entryTime >= cutoff);
    const byDay = new Map();
    for (const t of tr) {
      const d = dayKey(t.entryTime);
      const x = byDay.get(d) || { n: 0, w: 0, net: 0 };
      x.n += 1;
      x.w += t.net > 0 ? 1 : 0;
      x.net += t.net;
      byDay.set(d, x);
    }
    const days = [...byDay.entries()].sort();
    if (days.length) {
      console.log(`\n  DAILY — best combo (${top.name} + ${top.best.label})`);
      console.log(`   ${pad('date', 10)} | ${pad('n', 4, true)} | ${pad('wins', 4, true)} | ${pad('net$', 9, true)}`);
      for (const [d, x] of days) {
        console.log(`   ${pad(d, 10)} | ${pad(x.n, 4, true)} | ${pad(x.w, 4, true)} | ${pad(fmt(x.net), 9, true)}`);
      }
    }
  }

  console.log();
}

main();
