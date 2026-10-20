// CLI: download + cache historical candles for every timeframe the backtest
// compares. Run once; re-runs hit the on-disk cache for 12 hours.
//
//   node backtest/fetch.js
//   node backtest/fetch.js --days 180 --timeframes 5m,15m,30m,1h
//   node backtest/fetch.js --force

'use strict';

const { getCandles, RESOLUTION_SECONDS } = require('./lib/data');

function parseArgs(argv) {
  const args = { days: 365, timeframes: ['5m', '15m', '30m', '1h'], symbol: 'BTCUSD', force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') args.force = true;
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg === '--symbol') args.symbol = argv[++i];
    else if (arg === '--timeframes') args.timeframes = argv[++i].split(',');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    `Downloading ${args.symbol} candles: ${args.timeframes.join(', ')} over ${args.days} days\n`
  );

  for (const resolution of args.timeframes) {
    if (!RESOLUTION_SECONDS[resolution]) {
      console.log(`  ${resolution}: skipped (unsupported resolution)`);
      continue;
    }
    const started = Date.now();
    const { candles, source, requests } = await getCandles({
      symbol: args.symbol,
      resolution,
      days: args.days,
      force: args.force,
    });

    const first = candles[0];
    const last = candles[candles.length - 1];
    const spanDays = (last.time - first.time) / 86400;

    console.log(
      `  ${resolution.padEnd(4)} ${String(candles.length).padStart(6)} candles ` +
        `(${source}${requests ? `, ${requests} req` : ''}) ` +
        `${new Date(first.time * 1000).toISOString().slice(0, 10)} -> ` +
        `${new Date(last.time * 1000).toISOString().slice(0, 10)} ` +
        `span=${spanDays.toFixed(1)}d  ${Date.now() - started}ms`
    );
  }
}

main().catch((error) => {
  console.error('FETCH FAILED:', error.message);
  process.exit(1);
});
