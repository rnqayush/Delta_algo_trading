// Intraday exit-scheme sweep.
//
// Goal: find a config whose exits cut losses fast (loss ~= 1R) and let winners
// run (avg win >> avg loss). It builds the base timeframe by RESAMPLING the
// full-year 5m cache, so 15m/30m get a year of history (the cached 15m/30m
// files only cover ~4 months), then splits in/out of sample and ranks by the
// OUT-OF-SAMPLE result so a searched config cannot look good by luck.
//
//   node backtest/sweep-intraday.js --base 15 --spec-file backtest/specs/x.json --top 15
//
// Reuses the exact signal engine + simulator as live (live == tested).

'use strict';

const fs = require('fs');
const path = require('path');
const { loadCache } = require('./lib/data');
const { runBacktest } = require('./lib/sim');
const { DEFAULTS } = require('../src/strategies/lib/srBreakoutSignal');
const strategy = require('../src/strategies/strategies/srBreakoutStrategy');

const { normalizeCandles, resampleBars } = strategy.helpers;
const MIN_TRADES = 20;

function parseArgs(argv) {
  const args = { base: 15, split: 0.7, top: 15, minNet: 0, mode: 'both' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') args.base = Number(argv[++i]);
    else if (a === '--split') args.split = Number(argv[++i]);
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--min-net') args.minNet = Number(argv[++i]);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--spec-file') args.spec = JSON.parse(fs.readFileSync(path.resolve(argv[++i]), 'utf8'));
  }
  return args;
}

function candlesFor(baseMinutes) {
  const cached = loadCache('BTCUSD', '5m');
  if (!cached) throw new Error('No 5m cache. Run: node backtest/fetch.js');
  return resampleBars(normalizeCandles(cached.candles), baseMinutes, Infinity);
}

function expandGrid(spec) {
  let combos = [{}];
  for (const key of Object.keys(spec)) {
    const next = [];
    for (const combo of combos) for (const value of spec[key]) next.push({ ...combo, [key]: value });
    combos = next;
  }
  return combos;
}

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : 0);

function line(m) {
  return (
    `net=${String(Math.round(m.netPnl)).padStart(6)} pf=${String(m.profitFactor).padStart(5)} ` +
    `n=${String(m.trades).padStart(4)} win=${String(m.winRate).padStart(4)}% ` +
    `aw=${String(m.avgWin).padStart(6)} al=${String(m.avgLoss).padStart(7)} ` +
    `dd=${String(m.maxDrawdownPct).padStart(5)}% hold=${String(m.avgHoldBars).padStart(5)}`
  );
}

function main() {
  const args = parseArgs(process.argv);
  const candles = candlesFor(args.base);
  const splitIndex = Math.floor(candles.length * args.split);
  const inSample = candles.slice(0, splitIndex);
  const outSample = candles.slice(splitIndex);
  const combos = expandGrid(args.spec);
  const keys = Object.keys(args.spec);

  console.log(
    `\n=== BTCUSD resampled ${args.base}m | ${candles.length} bars ` +
      `(${round((candles[candles.length - 1].time - candles[0].time) / 86400000, 0)}d) | ` +
      `IS ${inSample.length} / OOS ${outSample.length} bars | ${combos.length} combos ===`
  );

  const rows = [];
  const started = Date.now();
  for (const combo of combos) {
    const params = { ...DEFAULTS, ...combo };
    const is = runBacktest({ candles: inSample, params, cfg: {} });
    if (is.metrics.trades < MIN_TRADES || is.metrics.netPnl <= args.minNet) continue;
    const oos = runBacktest({ candles: outSample, params, cfg: {} });
    rows.push({ combo, is: is.metrics, oos: oos.metrics });
  }

  // OOS-first: only trust configs that made money on data the search never saw.
  rows.sort((a, b) => b.oos.netPnl - a.oos.netPnl || b.is.netPnl - a.is.netPnl);
  console.log(`  ${rows.length} configs passed the in-sample gate in ${Date.now() - started}ms\n`);

  const oosPositive = rows.filter((r) => r.oos.netPnl > 0).length;
  console.log(`  configs profitable OUT-OF-SAMPLE: ${oosPositive}/${rows.length}\n`);
  console.log('  --- top by OUT-OF-SAMPLE net ---');
  for (const r of rows.slice(0, args.top)) {
    console.log(`  ${keys.map((k) => `${k}=${r.combo[k]}`).join(' ').padEnd(96)}`);
    console.log(`      IS  ${line(r.is)}`);
    console.log(`      OOS ${line(r.oos)}`);
  }
}

main();
