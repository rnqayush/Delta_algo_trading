// Breakout strategy backtest runner.
//
//   node backtest/run-breakout-backtest.js --mode compare
//   node backtest/run-breakout-backtest.js --tf 15m --mode single --spec '{"trendEma":200}'
//   node backtest/run-breakout-backtest.js --tf 15m --mode grid --stage stage1
//   node backtest/run-breakout-backtest.js --tf 15m --mode grid --spec '{"exitMode":["trail"]}'
//
// Grid searches run on an IN-SAMPLE window (default 70% of history) and the
// best configs are then measured on the untouched OUT-OF-SAMPLE remainder, so a
// "profitable" result cannot simply be an artefact of searching many combos.
//
// Candle data is real Delta Exchange history from the backtest/fetch.js cache.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadCache } = require('./lib/data');
const { runBacktest } = require('./lib/sim');
const { DEFAULTS } = require('../src/strategies/lib/srBreakoutSignal');

const MIN_TRADES = 20;

// Stage 1 — which structural choices matter most: do we want trend alignment,
// volume confirmation, an immediate entry or a retest, and how far back do
// levels stay valid?
const GRIDS = {
  stage1: {
    trendEma: [0, 200, 400],
    minVolMult: [0, 1.2],
    entryStyle: ['close', 'retest'],
    levelLookbackBars: [120, 240],
  },
  // Stage 2 — once the structure is fixed, tune the numeric thresholds.
  stage2: {
    breakBufferAtr: [0, 0.1, 0.25],
    minBodyRatio: [0.35, 0.5, 0.65],
    minRangeAtr: [0.6, 1.0],
    clusterAtrMult: [0.3, 0.6],
    exitMode: ['simple', 'trail'],
    targetR: [1.5, 2.5],
  },
  // Stage 3 — exit engineering, where "capturing the move" is decided.
  stage3: {
    exitMode: ['simple', 'trail'],
    targetR: [1.5, 2.0, 3.0, 4.0],
    beAtR: [0.5, 1.0, 1.5],
    trailAtrMult: [1.0, 2.0, 3.0],
    timeExitBars: [24, 48, 96],
  },
  // Stage 4 — stop engineering.
  stage4: {
    stopMode: ['level', 'atr', 'tightest'],
    stopAtrMult: [1.0, 2.0],
    stopLevelBufferAtr: [0.1, 0.5],
    minRiskAtr: [0.25, 0.5],
  },
};

function parseArgs(argv) {
  const args = {
    tf: '15m',
    mode: 'single',
    stage: 'stage1',
    top: 10,
    json: null,
    symbol: 'BTCUSD',
    split: 0.7,
    spec: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tf') args.tf = argv[++i];
    else if (arg === '--mode') args.mode = argv[++i];
    else if (arg === '--stage') args.stage = argv[++i];
    else if (arg === '--top') args.top = Number(argv[++i]);
    else if (arg === '--json') args.json = argv[++i];
    else if (arg === '--symbol') args.symbol = argv[++i];
    else if (arg === '--split') args.split = Number(argv[++i]);
    else if (arg === '--spec') args.spec = JSON.parse(argv[++i]);
    else if (arg === '--spec-file') args.specFile = argv[++i];
    else if (arg === '--all-tf') args.allTf = true;
  }
  if (args.specFile) args.spec = JSON.parse(fs.readFileSync(path.resolve(args.specFile), 'utf8'));
  return args;
}

function loadCandles(symbol, tf) {
  const cached = loadCache(symbol, tf);
  if (!cached) throw new Error(`No cached candles for ${symbol} ${tf}. Run: node backtest/fetch.js`);
  return cached.candles;
}

function expandGrid(spec) {
  let combos = [{}];
  for (const key of Object.keys(spec)) {
    const next = [];
    for (const combo of combos) {
      for (const value of spec[key]) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

function score(result) {
  const folds = result.foldMetrics;
  const foldCount = folds.length || 1;
  const positiveFolds = folds.filter((f) => f.net > 0).length;
  const minFoldNet = folds.length ? Math.min(...folds.map((f) => f.net)) : 0;
  return {
    positiveFolds,
    foldCount,
    minFoldNet,
    // Consistency-first score: a config that is positive in most time buckets is
    // far more trustworthy than one whose whole profit sits in a single bucket.
    robust: result.metrics.netPnl * (positiveFolds / foldCount),
  };
}

function evaluate(candles, params) {
  const result = runBacktest({ candles, params, cfg: {} });
  return { result, ...score(result) };
}

function compact(params, keys) {
  return keys.map((k) => `${k}=${params[k]}`).join(' ');
}

function fmt(m, tag = '') {
  return (
    `net=${String(Math.round(m.netPnl)).padStart(7)} ` +
    `pf=${String(m.profitFactor).padStart(5)} ` +
    `n=${String(m.trades).padStart(4)} ` +
    `win=${String(m.winRate).padStart(5)}% ` +
    `dd=${String(m.maxDrawdownPct).padStart(6)}% ` +
    `t/d=${String(m.tradesPerDay).padStart(5)} ` +
    `hold=${String(m.avgHoldBars).padStart(5)} ` +
    `exp=${String(m.expectancy).padStart(6)}` +
    tag
  );
}

function single(symbol, tf, params) {
  const candles = loadCandles(symbol, tf);
  const started = Date.now();
  const { result } = evaluate(candles, params);

  console.log(`\n=== ${symbol} ${tf} — single config (${Date.now() - started}ms) ===`);
  console.log('params:', JSON.stringify(params));
  console.log('bars:', candles.length, ' span:', result.metrics.spanDays, 'd');
  console.log(fmt(result.metrics));
  console.log(
    `  long n=${result.metrics.longs} net=${result.metrics.longNet} | ` +
      `short n=${result.metrics.shorts} net=${result.metrics.shortNet} | skipped=${result.skippedForSize}`
  );
  console.log('  folds:');
  for (const f of result.foldMetrics) {
    console.log(
      `    ${f.from}..${f.to}  n=${String(f.trades).padStart(4)}  net=${String(f.net).padStart(8)}  win=${f.winRate}%`
    );
  }
  const reasons = {};
  for (const t of result.trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  console.log('  exits:', JSON.stringify(reasons));
  return result;
}

function gridSearch(symbol, tf, spec, args) {
  const candles = loadCandles(symbol, tf);
  const splitIndex = Math.floor(candles.length * args.split);
  const inSample = candles.slice(0, splitIndex);
  const outSample = candles.slice(splitIndex);
  const combos = expandGrid(spec);
  const keys = Object.keys(spec);

  console.log(
    `\n=== ${symbol} ${tf} — grid: ${combos.length} configs | ` +
      `in-sample ${inSample.length} bars, out-of-sample ${outSample.length} bars ===`
  );

  const started = Date.now();
  const rows = [];

  for (const combo of combos) {
    const params = { ...DEFAULTS, ...combo };
    const { result, robust, positiveFolds, foldCount, minFoldNet } = evaluate(inSample, params);
    if (result.metrics.trades < MIN_TRADES) continue;
    rows.push({ combo, params, isMetrics: result.metrics, robust, positiveFolds, foldCount, minFoldNet });
  }

  // Rank by consistency across time buckets first (a durable edge shows up in
  // most folds), then by risk-adjusted total.
  rows.sort((a, b) => {
    if (b.positiveFolds !== a.positiveFolds) return b.positiveFolds - a.positiveFolds;
    if (b.robust !== a.robust) return b.robust - a.robust;
    return b.isMetrics.netPnl - a.isMetrics.netPnl;
  });
  console.log(`  ${rows.length} qualifying configs in ${Date.now() - started}ms\n`);

  console.log('  --- in-sample (searched) ---');
  for (const row of rows.slice(0, args.top)) {
    console.log(
      `  ${compact(row.combo, keys).padEnd(58)} ` +
        fmt(row.isMetrics, `  +f=${row.positiveFolds}/${row.foldCount} minF=${Math.round(row.minFoldNet)}`)
    );
  }

  console.log('\n  --- same configs on OUT-OF-SAMPLE (untouched) ---');
  const withOos = [];
  for (const row of rows.slice(0, args.top)) {
    const { result } = evaluate(outSample, row.params);
    withOos.push({ combo: row.combo, oos: result.metrics, isMetrics: row.isMetrics });
    console.log(`  ${compact(row.combo, keys).padEnd(58)} ${fmt(result.metrics)}`);
  }

  const oosPositive = withOos.filter((r) => r.oos.netPnl > 0).length;
  console.log(
    `\n  out-of-sample: ${oosPositive}/${withOos.length} of the top configs stayed profitable`
  );

  return { rows: rows.slice(0, args.top), withOos };
}

function main() {
  const args = parseArgs(process.argv);
  const timeframes = args.mode === 'compare' || args.allTf ? ['5m', '15m', '30m', '1h'] : [args.tf];
  const output = {};

  for (const tf of timeframes) {
    if (args.mode === 'compare') {
      const { result } = evaluate(loadCandles(args.symbol, tf), DEFAULTS);
      console.log(`\n=== ${args.symbol} ${tf} — default params ===`);
      console.log(fmt(result.metrics));
      output[tf] = result.metrics;
      continue;
    }

    if (args.mode === 'grid') {
      const spec = args.spec || GRIDS[args.stage];
      output[tf] = gridSearch(args.symbol, tf, spec, args);
      continue;
    }

    // default: single
    const result = single(args.symbol, tf, { ...DEFAULTS, ...(args.spec || {}) });
    output[tf] = { metrics: result.metrics, folds: result.foldMetrics };
  }

  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(output, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
}

main();
