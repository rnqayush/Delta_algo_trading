// Does the multi-symbol scanner's SELECTION add edge — or just add fees?
//
// The live proposal is: each cycle, rank every perp by liquidity (24h quote
// volume) and momentum (|24h % change|), then trade only the top-K with the
// 2h block breakout. More symbols means more trades, and the 32-coin test
// already showed fees eat most of the alpha — so the only question that
// matters is whether the RANKING picks better-than-average symbols.
//
// To answer it, the same breakout is replayed under three selection rules and
// the results are compared head to head. Every arm sees identical candles,
// identical brackets and identical fees; the ONLY thing that changes is which
// symbols are allowed to trade:
//
//   static   — the whole universe is always allowed (the old behaviour)
//   scanner  — only the top-K by (volume floor + |24h % change|) at each epoch
//   randomK  — K symbols drawn at random each epoch (the control)
//
// If "scanner" ≈ "randomK", the ranking is noise and the whole idea is just a
// fee generator. If "scanner" > "randomK" by a real margin, the selection has
// information worth wiring into the live bot.
//
// Selection uses ONLY candles that closed before the epoch, so there is no
// look-ahead: the score at time T is computed from data available at T.
//
//   node backtest/scanner-selector.js
//   node backtest/scanner-selector.js --days 14 --topk 5 --refresh 12
//   node backtest/scanner-selector.js --minvol 500000 --slot global

'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./lib/data');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CFG = {
  equity: 1200,
  // Bracket as a % of the entry PRICE (the "Price %" model), at 1x notional:
  // a stop-out costs 1% of equity, a winner pays 5%.
  stopPct: 0.01,
  targetPct: 0.05,
  feeMaker: 0.0002, // entry (limit)
  feeTaker: 0.0005, // exit (market)
  slippage: 0.0002, // extra fill cost on a stop-out
  resolution: '5m',
  barSec: 300,
  blockSec: 2 * 60 * 60,
  daySec: 86400,
  refreshHours: 24,
  topK: 5,
  days: 7,
  minVol: null, // null -> universe median (a self-calibrating floor)
  feeMult: 1, // scales every fee; lets the cost sensitivity be swept
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------

// Auto-discovers every cached 5m series in backtest/data.
function discoverUniverse() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((file) => file.endsWith(`_${CFG.resolution}.json`))
    .map((file) => file.replace(`_${CFG.resolution}.json`, ''))
    .sort();
}

function loadSeries(symbol) {
  const file = path.join(DATA_DIR, `${symbol}_${CFG.resolution}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.candles) ? parsed.candles : null;
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Selection score: volume floor + |24h % change|
// ---------------------------------------------------------------------------

// Quote volume over the trailing 24h, approximated from candles as
// sum(volume * close) so symbols with different contract sizes compare fairly.
function trailingQuoteVolume(candles, atSec) {
  const barsPerDay = CFG.daySec / CFG.barSec;
  const from = atSec - CFG.daySec;
  let total = 0;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (candles[i].time < from) break;
    if (candles[i].time >= atSec) continue;
    total += Number(candles[i].volume || 0) * Number(candles[i].close || 0);
  }
  if (barsPerDay <= 0) return total;
  return total;
}

// Close nearest to (but not after) `atSec - 24h`, for the % change.
function closeAsOf(candles, atSec) {
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (candles[i].time <= atSec) return Number(candles[i].close || 0);
  }
  return 0;
}

// The scanner's ranking, evaluated with information available at `atSec` only.
function scoreSymbols(seriesBySymbol, atSec, minVol) {
  const scored = [];
  for (const [symbol, candles] of seriesBySymbol.entries()) {
    const nowClose = closeAsOf(candles, atSec);
    const thenClose = closeAsOf(candles, atSec - CFG.daySec);
    if (!(nowClose > 0) || !(thenClose > 0)) continue;

    const vol24 = trailingQuoteVolume(candles, atSec);
    if (minVol !== null && vol24 < minVol) continue;

    scored.push({
      symbol,
      vol24,
      changePct: Math.abs((nowClose - thenClose) / thenClose),
    });
  }
  scored.sort((a, b) => b.changePct - a.changePct);
  return scored;
}

// ---------------------------------------------------------------------------
// Signal generation — mirrors Block2hBreakout5m.evaluate exactly
// ---------------------------------------------------------------------------

// Blocks are anchored to UTC midnight: the backtest has no "server start" to
// anchor to, and midnight is deterministic and reproducible.
function buildSignals(candles, startSec, endSec) {
  const signals = [];
  const byTime = new Map();
  for (const candle of candles) byTime.set(Number(candle.time), candle);

  let lastTradeBlock = -1;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i];
    const t = Number(bar.time);
    if (t < startSec || t >= endSec) continue;

    const blockStart = Math.floor(t / CFG.blockSec) * CFG.blockSec;
    if (blockStart === lastTradeBlock) continue; // one trade per block
    if (t <= blockStart) continue; // that candle IS the level candle

    const level = byTime.get(blockStart);
    if (!level) continue; // level candle missing from the feed

    const levelHigh = Number(level.high);
    const levelLow = Number(level.low);
    if (!(levelHigh > levelLow)) continue;

    const close = Number(bar.close);
    let dir = 0;
    if (close > levelHigh) dir = 1;
    else if (close < levelLow) dir = -1;
    if (dir === 0) continue;

    const stopDistance = CFG.stopPct * close;
    const targetDistance = CFG.targetPct * close;
    if (!(stopDistance > 0) || !(targetDistance > 0)) continue;

    lastTradeBlock = blockStart;
    signals.push({
      time: t,
      blockStart,
      dir,
      entry: close,
      stop: close - dir * stopDistance,
      target: close + dir * targetDistance,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Trade simulation
// ---------------------------------------------------------------------------

// Walks forward from the entry bar to the first of: stop, target, or the last
// bar of the entry's UTC day (end-of-day close). Fills are gap-aware — if the
// bar OPENS beyond a level, the fill is the open, not the level — and when a
// single bar touches BOTH levels the stop is assumed to hit first (the
// conservative choice, since the intrabar path is unknown).
function resolveExit(candles, signalIndex, signal) {
  const entryNotional = CFG.equity; // 1x notional
  const quantity = entryNotional / signal.entry;

  const entryCost = CFG.feeMaker * entryNotional * CFG.feeMult;

  const dayEnd = (Math.floor(signal.time / CFG.daySec) + 1) * CFG.daySec;

  for (let i = signalIndex + 1; i < candles.length; i += 1) {
    const bar = candles[i];
    const t = Number(bar.time);

    const hitStop = signal.dir === 1
      ? Number(bar.low) <= signal.stop
      : Number(bar.high) >= signal.stop;
    const hitTarget = signal.dir === 1
      ? Number(bar.high) >= signal.target
      : Number(bar.low) <= signal.target;

    if (hitStop) {
      const fill = signal.dir === 1
        ? Math.min(Number(bar.open), signal.stop)
        : Math.max(Number(bar.open), signal.stop);
      return closeTrade(signal, quantity, fill, entryCost, true, 'stop', t);
    }
    if (hitTarget) {
      const fill = signal.dir === 1
        ? Math.max(Number(bar.open), signal.target)
        : Math.min(Number(bar.open), signal.target);
      return closeTrade(signal, quantity, fill, entryCost, false, 'target', t);
    }

    if (t >= dayEnd) {
      return closeTrade(signal, quantity, Number(bar.close), entryCost, true, 'eod', t);
    }
  }

  const last = candles[candles.length - 1];
  if (!last) return null;
  return closeTrade(signal, quantity, Number(last.close), entryCost, true, 'data-end', Number(last.time));
}

function closeTrade(signal, quantity, exitPrice, entryCost, isTakerStop, reason, exitTime) {
  const gross = (exitPrice - signal.entry) * signal.dir * quantity;
  const exitNotional = exitPrice * quantity;
  const exitCost = (CFG.feeTaker * exitNotional + (isTakerStop ? CFG.slippage * exitNotional : 0)) * CFG.feeMult;
  const fees = entryCost + exitCost;
  const net = gross - fees;

  return {
    symbol: signal.symbol,
    dir: signal.dir,
    entryTime: signal.time,
    exitTime,
    entry: signal.entry,
    exit: exitPrice,
    gross,
    fees,
    net,
    r: (exitPrice - signal.entry) * signal.dir / (CFG.stopPct * signal.entry),
    reason,
  };
}

// Per-symbol independent simulation: one position per symbol at a time (the
// strategy's own "never arm a second entry" rule), but symbols run in parallel.
function simulatePerSymbol(signalsBySymbol, allowedFn) {
  const trades = [];
  for (const [symbol, signals] of signalsBySymbol.entries()) {
    let busyUntil = -1;
    for (const signal of signals) {
      if (signal.time <= busyUntil) continue; // a position is already on
      if (!allowedFn(symbol, signal.time)) continue;

      const candles = seriesIndex.get(symbol);
      const index = candles.timeToIndex.get(signal.time);
      if (index === undefined) continue;

      const trade = resolveExit(candles.list, index, { ...signal, symbol });
      if (!trade) continue;
      trades.push(trade);
      busyUntil = trade.exitTime;
    }
  }
  return trades.sort((a, b) => a.exitTime - b.exitTime);
}

// Basket-wide single slot: every symbol competes for ONE global position, which
// is the live rule the user picked ("1 position at a time").
function simulateGlobalSlot(signalsBySymbol, allowedFn) {
  const events = [];
  for (const [symbol, signals] of signalsBySymbol.entries()) {
    for (const signal of signals) {
      if (!allowedFn(symbol, signal.time)) continue;
      events.push({ ...signal, symbol });
    }
  }
  events.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));

  const trades = [];
  let freeAt = -1;
  for (const event of events) {
    if (event.time < freeAt) continue; // the single slot is occupied
    const candles = seriesIndex.get(event.symbol);
    const index = candles.timeToIndex.get(event.time);
    if (index === undefined) continue;

    const trade = resolveExit(candles.list, index, event);
    if (!trade) continue;
    trades.push(trade);
    freeAt = trade.exitTime;
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function summarize(trades) {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const gross = trades.reduce((sum, t) => sum + t.gross, 0);
  const fees = trades.reduce((sum, t) => sum + t.fees, 0);
  const net = trades.reduce((sum, t) => sum + t.net, 0);
  const grossWin = wins.reduce((sum, t) => sum + t.gross, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.gross, 0));

  // Simple max drawdown on the closed-trade equity curve.
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const trade of trades) {
    equity += trade.net;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    gross,
    fees,
    net,
    avgR: trades.length ? trades.reduce((sum, t) => sum + t.r, 0) / trades.length : 0,
    maxDd,
  };
}

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return 'inf';
  return value.toFixed(digits);
}

function pad(text, width, right = false) {
  const value = String(text);
  return right ? value.padStart(width) : value.padEnd(width);
}

function printArm(label, stats) {
  console.log(
    `${pad(label, 10)} | ${pad(stats.trades, 7, true)} | ${pad((stats.winRate * 100).toFixed(1) + '%', 7, true)} | ` +
      `${pad(fmt(stats.pf), 6, true)} | ${pad('$' + fmt(stats.net), 11, true)} | ` +
      `${pad('$' + fmt(stats.gross), 11, true)} | ${pad('$' + fmt(stats.fees), 10, true)} | ` +
      `${pad(fmt(stats.avgR, 3), 7, true)} | ${pad('$' + fmt(stats.maxDd), 9, true)}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const seriesIndex = new Map(); // symbol -> { list, timeToIndex }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  CFG.days = Number(args.days) || CFG.days;
  CFG.topK = Number(args.topk) || CFG.topK;
  CFG.refreshHours = Number(args.refresh) || CFG.refreshHours;
  CFG.minVol = args.minvol !== undefined ? Number(args.minvol) : CFG.minVol;
  const slotMode = args.slot === 'per-symbol' ? 'per-symbol' : 'global';

  const universe = discoverUniverse();
  if (!universe.length) {
    console.error('No cached 5m series found in backtest/data. Run backtest/fetch.js first.');
    process.exit(1);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = Math.floor(nowSec / CFG.daySec) * CFG.daySec; // last complete UTC day
  const startSec = endSec - CFG.days * CFG.daySec;

  // Load and window each series. A symbol needs coverage of most of the window
  // to be comparable, otherwise a late listing would look like a bad pick.
  const seriesBySymbol = new Map();
  const dropped = [];
  for (const symbol of universe) {
    const candles = loadSeries(symbol);
    if (!candles || !candles.length) {
      dropped.push(`${symbol} (no data)`);
      continue;
    }
    const list = candles
      .map((c) => ({ ...c, time: Number(c.time) }))
      .filter((c) => c.time >= startSec && c.time < endSec)
      .sort((a, b) => a.time - b.time);

    const expected = (CFG.days * CFG.daySec) / CFG.barSec;
    if (list.length < expected * 0.9) {
      dropped.push(`${symbol} (${list.length}/${expected} bars)`);
      continue;
    }

    const timeToIndex = new Map();
    list.forEach((candle, index) => timeToIndex.set(candle.time, index));
    seriesBySymbol.set(symbol, list);
    seriesIndex.set(symbol, { list, timeToIndex });
  }

  console.log(`\nScanner selection backtest — ${CFG.resolution} bars`);
  console.log(
    `Window: ${new Date(startSec * 1000).toISOString().slice(0, 10)} → ` +
      `${new Date(endSec * 1000).toISOString().slice(0, 10)} (${CFG.days}d)`
  );
  console.log(
    `Universe: ${seriesBySymbol.size} symbols` + (dropped.length ? ` (dropped ${dropped.length}: ${dropped.join(', ')})` : '')
  );
  console.log(
    `Bracket: -${(CFG.stopPct * 100).toFixed(0)}% / +${(CFG.targetPct * 100).toFixed(0)}% of price at 1x notional ` +
      `| fees ${(CFG.feeMaker * 100).toFixed(2)}% maker / ${(CFG.feeTaker * 100).toFixed(2)}% taker + ${(CFG.slippage * 100).toFixed(2)}% slip`
  );

  // ---- Signals -----------------------------------------------------------
  const signalsBySymbol = new Map();
  let totalSignals = 0;
  for (const [symbol, candles] of seriesBySymbol.entries()) {
    const signals = buildSignals(candles, startSec, endSec);
    signalsBySymbol.set(symbol, signals);
    totalSignals += signals.length;
  }
  console.log(`Signals generated: ${totalSignals} across ${signalsBySymbol.size} symbols\n`);

  // ---- Selection epochs --------------------------------------------------
  const refreshSec = CFG.refreshHours * 3600;
  const epochs = [];
  for (let t = startSec + CFG.daySec; t < endSec; t += refreshSec) epochs.push(t);

  // The volume floor is either given or self-calibrated to the universe median
  // (computed at the first epoch) so the filter is not an arbitrary constant.
  let minVol = CFG.minVol;
  if (minVol === null && epochs.length) {
    const vols = [...seriesBySymbol.entries()].map(([symbol, candles]) =>
      trailingQuoteVolume(candles, epochs[0])
    );
    vols.sort((a, b) => a - b);
    minVol = vols[Math.floor(vols.length / 2)] || 0;
    console.log(`Volume floor: auto (universe median) = $${Math.round(minVol).toLocaleString()}`);
  } else if (minVol !== null) {
    console.log(`Volume floor: explicit = $${Math.round(minVol).toLocaleString()}`);
  }
  console.log(`Epochs: ${epochs.length} (refresh every ${CFG.refreshHours}h), top-K = ${CFG.topK}\n`);

  const selectedAt = new Map(); // epochSec -> Set(symbol)
  const eligibleAt = new Map(); // epochSec -> ranked array

  for (const epoch of epochs) {
    const ranked = scoreSymbols(seriesBySymbol, epoch, minVol);
    eligibleAt.set(epoch, ranked);
    selectedAt.set(epoch, new Set(ranked.slice(0, CFG.topK).map((entry) => entry.symbol)));
  }

  // The randomK control is rebuilt for any seed, so the whole comparison can be
  // repeated: if the scanner does not beat most random draws, its ranking
  // carries no information.
  const buildRandomAt = (seed) => {
    const rnd = mulberry32(seed);
    const map = new Map();
    for (const epoch of epochs) {
      const pool = eligibleAt.get(epoch).map((entry) => entry.symbol);
      const picked = new Set();
      while (picked.size < Math.min(CFG.topK, pool.length)) {
        picked.add(pool[Math.floor(rnd() * pool.length)]);
      }
      map.set(epoch, picked);
    }
    return map;
  };

  const seedPrimary = Number(args.seed) || 1337;
  const randomAt = buildRandomAt(seedPrimary);

  const epochFor = (timeSec) => {
    let best = null;
    for (const epoch of epochs) {
      if (epoch <= timeSec) best = epoch;
      else break;
    }
    return best;
  };

  const allowStatic = () => true;
  const allowScanner = (symbol, timeSec) => {
    const epoch = epochFor(timeSec);
    return epoch !== null && selectedAt.get(epoch).has(symbol);
  };
  const allowRandom = (symbol, timeSec) => {
    const epoch = epochFor(timeSec);
    return epoch !== null && randomAt.get(epoch).has(symbol);
  };

  // ---- Run the arms ------------------------------------------------------
  const simulate = slotMode === 'global' ? simulateGlobalSlot : simulatePerSymbol;
  const arms = [
    ['static', simulate(signalsBySymbol, allowStatic)],
    ['scanner', simulate(signalsBySymbol, allowScanner)],
    ['randomK', simulate(signalsBySymbol, allowRandom)],
  ];

  console.log(`Slot mode: ${slotMode}${slotMode === 'global' ? ' (one position across the whole basket)' : ' (one per symbol)'}\n`);
  console.log(
    `${pad('arm', 10)} | ${pad('trades', 7, true)} | ${pad('win%', 7, true)} | ${pad('PF', 6, true)} | ` +
      `${pad('net', 11, true)} | ${pad('gross', 11, true)} | ${pad('fees', 10, true)} | ${pad('avgR', 7, true)} | ${pad('maxDD', 9, true)}`
  );
  console.log('-'.repeat(108));
  for (const [label, trades] of arms) printArm(label, summarize(trades));
  console.log();

  const scannerStats = summarize(arms[1][1]);
  const randomStats = summarize(arms[2][1]);
  const staticStats = summarize(arms[0][1]);
  const feeDrag = staticStats.gross > 0 ? (staticStats.fees / staticStats.gross) * 100 : 0;

  console.log('Verdict');
  console.log(`  scanner vs randomK net: $${fmt(scannerStats.net - randomStats.net)}  (the value of the ranking itself)`);
  console.log(`  scanner vs static  net: $${fmt(scannerStats.net - staticStats.net)}  (the value of trading fewer names)`);
  console.log(`  fees as % of gross alpha (static arm): ${feeDrag.toFixed(1)}%`);

  // ---- Is the scanner's edge real? ---------------------------------------
  // The scanner is compared against many random draws of the same size. If it
  // sits inside the random band, the ranking is noise.
  const seedCount = Number(args.seeds) || 0;
  if (seedCount > 1) {
    const nets = [];
    const rs = [];
    for (let i = 0; i < seedCount; i += 1) {
      const map = buildRandomAt(1000 + i * 7919);
      const allow = (symbol, timeSec) => {
        const epoch = epochFor(timeSec);
        return epoch !== null && map.get(epoch).has(symbol);
      };
      const stats = summarize(simulate(signalsBySymbol, allow));
      nets.push(stats.net);
      rs.push(stats.avgR);
    }
    nets.sort((a, b) => a - b);
    rs.sort((a, b) => a - b);
    const pct = (sorted, value) => (sorted.filter((v) => v < value).length / sorted.length) * 100;

    console.log(
      `\nrandomK over ${seedCount} seeds | net p10/p50/p90: ` +
        `$${fmt(nets[Math.floor(seedCount * 0.1)])} / $${fmt(nets[Math.floor(seedCount * 0.5)])} / $${fmt(nets[Math.floor(seedCount * 0.9)])}`
    );
    console.log(
      `                         | avgR p10/p50/p90: ` +
        `${fmt(rs[Math.floor(seedCount * 0.1)], 3)} / ${fmt(rs[Math.floor(seedCount * 0.5)], 3)} / ${fmt(rs[Math.floor(seedCount * 0.9)], 3)}`
    );
    console.log(
      `  scanner percentile vs random: net ${pct(nets, scannerStats.net).toFixed(0)}th, ` +
        `avgR ${pct(rs, scannerStats.avgR).toFixed(0)}th`
    );
  }

  // ---- Cost sensitivity --------------------------------------------------
  // closeTrade reads CFG.feeMult at call time, so scaling it and re-running
  // measures how much of the result is the strategy and how much is the fee.
  if (args.feeSweep) {
    const mults = [1, 0.75, 0.5, 0.25, 0];
    console.log('\nCost sensitivity — net $ per arm as fees scale');
    console.log(
      `${pad('arm', 10)} | ` + mults.map((m) => pad(`${(m * 100).toFixed(0)}%`, 9, true)).join(' | ')
    );
    console.log('-'.repeat(10 + mults.length * 12));
    for (const [label, allowedFn] of [
      ['static', allowStatic],
      ['scanner', allowScanner],
      ['randomK', allowRandom],
    ]) {
      const row = [];
      for (const m of mults) {
        CFG.feeMult = m;
        row.push(pad('$' + fmt(summarize(simulate(signalsBySymbol, allowedFn)).net), 9, true));
      }
      console.log(`${pad(label, 10)} | ${row.join(' | ')}`);
    }
    CFG.feeMult = 1;
    console.log('  100% = live fees (2bps maker entry, 5bps taker + 2bps slip on stops)');
  }

  // ---- What the scanner actually picked ----------------------------------
  console.log('\nScanner picks per epoch');
  for (const epoch of epochs) {
    const ranked = eligibleAt.get(epoch);
    const stamp = new Date(epoch * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const picks = ranked.slice(0, CFG.topK)
      .map((entry) => `${entry.symbol.replace('USD', '')} ${(entry.changePct * 100).toFixed(1)}%`)
      .join(', ');
    console.log(`  ${stamp} (${ranked.length} eligible): ${picks}`);
  }
  console.log();
}

// Small deterministic PRNG so the randomK control is reproducible.
function mulberry32(seed) {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
