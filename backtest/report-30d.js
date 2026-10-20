// Day-wise PnL report for the active S/R breakout config over the last N days
// of REAL Delta Exchange BTCUSD candles.
//
//   node backtest/report-30d.js [days] [tf]
//
// The backtest is run over the whole cached window (so the indicators warm up
// naturally) and only the trades that CLOSED inside the reporting window are
// reported. Timestamps come from Delta and are bucketed into IST days
// (UTC+5:30). Positions are sized exactly like the project backtest:
// $1,200 equity, 1% risk per trade.
//
// The candle series is built with the same resample the live strategy uses, so
// the report reflects exactly what the strategy sees.

'use strict';

const { loadCache } = require('./lib/data');
const { runBacktest } = require('./lib/sim');
const { mergeParams } = require('../src/strategies/lib/srBreakoutSignal');
const strategy = require('../src/strategies/strategies/srBreakoutStrategy');
const { TUNED, resampleBars, normalizeCandles } = strategy.helpers;

const DAYS = Number(process.argv[2]) || 30;
const TF = (process.argv[3] || `${TUNED.baseMinutes}m`).toLowerCase();
const BASE_MINUTES = TF.endsWith('m') ? parseInt(TF, 10) : 60;
// The feed the live engine streams for this config (5m or 15m); base bars are
// built by aggregating up from it, exactly like the strategy does.
const FEED_TF = `${TUNED.feedMinutes || 15}m`;
const SYMBOL = 'BTCUSD';
const IST_OFFSET_MS = 5.5 * 3600 * 1000; // candle times here are epoch ms
const DAY_MS = 86400000;
const INITIAL_EQUITY = 1200; // backtest default

const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const money = (v) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);

function main() {
  const cached = loadCache(SYMBOL, FEED_TF);
  if (!cached) throw new Error(`No cached ${FEED_TF} candles. Run: node backtest/fetch.js --force`);
  const candles = resampleBars(normalizeCandles(cached.candles), BASE_MINUTES, Infinity);

  const params = mergeParams(TUNED);
  const { trades, metrics } = runBacktest({ candles, params, cfg: {} });

  const dataEnd = candles[candles.length - 1].time;
  const dataStart = candles[0].time;
  const from = dataEnd - DAYS * DAY_MS;

  const windowTrades = trades.filter((t) => t.exitTime >= from);
  const byDay = new Map();

  for (const t of windowTrades) {
    const day = istDate(t.exitTime);
    const row = byDay.get(day) || { day, trades: 0, wins: 0, losses: 0, net: 0, r: 0, oneLot: 0 };
    row.trades += 1;
    if (t.net > 0) row.wins += 1;
    else row.losses += 1;
    row.net += t.net;
    row.r += t.rMultiple;
    // Everything in the sim scales linearly with contracts, so a 1-lot PnL is
    // just net/contracts — this is what STRATEGY_FIXED_CONTRACTS=1 produces live.
    row.oneLot += t.contracts > 0 ? t.net / t.contracts : 0;
    byDay.set(day, row);
  }

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));

  console.log(`\n=== ${strategy.name} day-wise PnL — ${SYMBOL} ${BASE_MINUTES}m — last ${DAYS} days (real Delta data) ===`);
  console.log(
    `data: ${istDate(dataStart)} -> ${istDate(dataEnd)} IST | report: ${istDate(from)} -> ${istDate(dataEnd)}`
  );
  console.log(
    `sizing: $${INITIAL_EQUITY} equity, 1% risk/trade | ` +
      `${params.levelSource}/retest/${params.stopAtrMult}xATR stop/${params.targetR}R target/` +
      `${params.minTouches}+ touches/${params.levelLookbackBars}-bar levels/ema${params.trendEma}/` +
      `retest ${params.retestValidityBars} bars\n`
  );

  const header = 'date        trades  W   L     net\$      1lot\$       R      cum\$';
  console.log(header);
  console.log('-'.repeat(header.length));

  let cum = 0;
  let totalR = 0;
  let totalOneLot = 0;
  for (const d of days) {
    cum += d.net;
    totalR += d.r;
    totalOneLot += d.oneLot;
    console.log(
      `${d.day}  ${String(d.trades).padStart(5)}  ${String(d.wins).padStart(2)}  ${String(d.losses).padStart(2)}  ` +
        `${money(d.net).padStart(9)}  ${money(d.oneLot).padStart(9)}  ` +
        `${((d.r >= 0 ? '+' : '') + d.r.toFixed(2)).padStart(6)}  ${money(cum).padStart(9)}`
    );
  }

  console.log('-'.repeat(header.length));

  const net = windowTrades.reduce((s, t) => s + t.net, 0);
  const wins = windowTrades.filter((t) => t.net > 0);
  const losses = windowTrades.filter((t) => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const greenDays = days.filter((d) => d.net > 0).length;
  const redDays = days.filter((d) => d.net < 0).length;
  const flatDays = days.filter((d) => d.net === 0).length;
  const best = days.length ? days.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = days.length ? days.reduce((a, b) => (b.net < a.net ? b : a)) : null;

  let peak = 0;
  let dd = 0;
  let run = 0;
  for (const d of days) {
    run += d.net;
    if (run > peak) peak = run;
    dd = Math.min(dd, run - peak);
  }

  console.log(`\nwindow total      : ${money(net)}  (${((net / INITIAL_EQUITY) * 100).toFixed(2)}% of $${INITIAL_EQUITY})  ${totalR.toFixed(1)}R  |  1-lot: ${money(totalOneLot)}`);
  console.log(`trades            : ${windowTrades.length}  (${wins.length}W / ${losses.length}L, win ${((wins.length / Math.max(1, windowTrades.length)) * 100).toFixed(1)}%)`);
  console.log(`profit factor     : ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'n/a'}`);
  console.log(`avg win / avg loss: ${money(wins.length ? grossWin / wins.length : 0)} / ${money(-(losses.length ? grossLoss / losses.length : 0))}`);
  console.log(`days              : ${days.length} active (${greenDays} green / ${redDays} red / ${flatDays} flat)`);
  console.log(`best / worst day  : ${best ? `${best.day} ${money(best.net)}` : '-'} / ${worst ? `${worst.day} ${money(worst.net)}` : '-'}`);
  console.log(`max day-to-day DD : ${money(dd)}`);
  console.log(`avg trades/day    : ${windowTrades.length / Math.max(1, days.length) === 0 ? 0 : (windowTrades.length / Math.max(1, days.length)).toFixed(2)}`);

  const eod = windowTrades.filter((t) => t.reason === 'eod').length;
  if (eod) console.log(`note              : ${eod} position force-closed at the last bar (data end)`);

  // Full-history context so the 30-day slice is not read in isolation.
  console.log(`\n(= full cached window since ${istDate(dataStart)}: ${metrics.trades} trades, net ${money(metrics.netPnl)}, PF ${metrics.profitFactor}, DD ${metrics.maxDrawdownPct}%)`);
}

main();
