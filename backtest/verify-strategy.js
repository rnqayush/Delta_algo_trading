// Verifies that the LIVE strategy (src/strategies/strategies/srBreakoutStrategy.js)
// produces exactly the same breakout signals as the backtest signal engine.
//
// It feeds real candles into the strategy the same way the trading engine does
// (5m or 15m, per the active config's `feedMinutes`), resamples them to the
// config's base timeframe, and compares the emitted setups against
// srBreakoutSignal.signalAt() run directly on that base series.
//
// The reference runs on the FULL history, but the live strategy only ever sees
// the last WINDOW feed candles — so the comparison is restricted to the bars the
// live path can actually reach (>= the first bar it evaluates). With the
// required window (see the strategy header) the two must agree exactly.
//
//   node backtest/verify-strategy.js [windowFeedCandles]

'use strict';

const { loadCache } = require('./lib/data');
const { prepare, signalAt, mergeParams } = require('../src/strategies/lib/srBreakoutSignal');
const strategy = require('../src/strategies/strategies/srBreakoutStrategy');
const { resampleBars, normalizeCandles, minWarmupBars, feedResolution, feedKey, TUNED } = strategy.helpers;

const FEED_TF = feedResolution(TUNED);
const FEED_KEY = feedKey(TUNED);
const FEED_MINUTES = parseInt(FEED_TF, 10);
const WINDOW = Number(process.argv[2]) || 2000; // feed candles per cycle
const BASE_MINUTES = TUNED.baseMinutes || 15;

function main() {
  const cached = loadCache('BTCUSD', FEED_TF);
  if (!cached) throw new Error(`No cached ${FEED_TF} candles. Run: node backtest/fetch.js`);

  // The cache stores Delta's epoch SECONDS; normalise to ms once, up front.
  const feedCandles = normalizeCandles(cached.candles);
  const params = mergeParams(TUNED);

  // --- reference: what the backtest engine says on the strategy's own series ---
  const candles = resampleBars(feedCandles, BASE_MINUTES, Infinity); // all buckets
  const prep = prepare(candles, params);
  const expected = new Map();
  for (let i = prep.warmup; i < candles.length; i += 1) {
    const signal = signalAt(prep, i, params);
    if (signal) expected.set(candles[i].time, signal);
  }

  // --- live path: feed a rolling window and collect the strategy's setups ---
  strategy.reset();
  const minBars = minWarmupBars(params);
  const got = new Map();
  let firstEvalTime = Infinity;
  for (let end = WINDOW; end <= feedCandles.length; end += 1) {
    const window = feedCandles.slice(end - WINDOW, end);
    const last = window[window.length - 1];
    const now = last.time + FEED_MINUTES * 60 * 1000; // "now" = when that candle closed
    // The first bar the strategy can actually evaluate (once warm-up is met).
    if (firstEvalTime === Infinity) {
      const cands = resampleBars(normalizeCandles(window), BASE_MINUTES, now);
      if (cands.length >= minBars) firstEvalTime = cands[cands.length - 1].time;
    }
    const signal = strategy.evaluate({ price: last.close, [FEED_KEY]: window, daily: {} }, {});
    if (signal.action === 'HOLD') continue;
    const barTime = signal.meta.barTime;
    if (!got.has(barTime)) got.set(barTime, signal);
  }

  // --- compare, over the bars the live path could reach ---
  let missing = 0;
  let sideMismatch = 0;
  let priceMismatch = 0;
  for (const [time, exp] of expected) {
    if (time < firstEvalTime) continue; // before the live window starts
    const act = got.get(time);
    if (!act) {
      missing += 1;
      continue;
    }
    if (act.action !== exp.action) sideMismatch += 1;
    if (Math.abs(act.meta.level - exp.meta.level) > 0.5) priceMismatch += 1;
  }
  const extras = [...got.keys()].filter((time) => !expected.has(time));

  console.log(`strategy timeframe          : ${BASE_MINUTES}m (from the ${FEED_TF} feed)`);
  console.log(`window (${FEED_TF} candles)        : ${WINDOW}`);
  console.log(`reference setups (reachable): ${[...expected.keys()].filter((t) => t >= firstEvalTime).length}`);
  console.log(`live strategy setups        : ${got.size}`);
  console.log(`missing in live             : ${missing}`);
  console.log(`EXTRA in live               : ${extras.length}`);
  console.log(`side mismatches             : ${sideMismatch}`);
  console.log(`level mismatches            : ${priceMismatch}`);

  const ok = missing === 0 && extras.length === 0 && sideMismatch === 0 && priceMismatch === 0;
  console.log(ok ? '\nOK — live signals match the backtest exactly.' : '\nMISMATCH — investigate before going live.');
  process.exitCode = ok ? 0 : 1;
}

main();
