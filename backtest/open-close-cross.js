// "Open Close Cross Strategy R5.1" (TradingView Pine v3) — 1m backtest.
//
// THE SYSTEM
// ----------
//   SMMA(8) of the close and SMMA(8) of the open, on the 1m chart.
//   bull cross (close-MA over open-MA) -> long;  bear cross -> short.
//   Always-in reversal: the opposite cross closes and flips, no stop/target
//   in the published script.
//
// This backtest replays the LIVE port (src/strategies/strategies/openCloseCross1m.js)
// bar by bar so the RISK CONTROLS it now carries can be measured against the
// bare published rule:
//
//   * ATR stop     — a fixed ATR(14) x MULT stop, checked intrabar and filled
//                    at the stop price (the exchange rests it as reduce-only).
//   * time stop    — flatten at the bar where the trade reaches TIME_STOP_MIN.
//   * loss cooldown— after a LOSING close, block the next entry for COOLDOWN_MIN.
//
// The script prints a 4-row comparison per symbol (baseline, +ATR, +ATR+time,
// +ALL) for BOTH signal directions, so the net effect of each control is
// isolated. The dominant sample was AINUSD; the live instrument is ARIAUSD.
//
//   node backtest/open-close-cross.js --symbols AINUSD,ARIAUSD --days 17
//   node backtest/open-close-cross.js --symbols ARIAUSD --days 3 --free
//
// Options:
//   --symbols     comma-separated (default TRADING_SYMBOL or ARIAUSD)
//   --days        look-back window in days, default 17
//   --atr-period  ATR length, default 14
//   --atr-mult    stop distance in ATRs, default 1 (= the live ATR_STOP_MULT)
//   --time-stop   time stop in minutes, default 10
//   --cooldown    post-loss cooldown in minutes, default 15
//   --cooldown-sweep  comma list of cooldowns (e.g. 0,15,30,60,120) — prints one
//                     row per length instead of the four-variant table
//   --notional    notional per position as x equity, default 1.0
//   --capital     starting equity, default 10000
//   --fee/--slip  bps per leg, defaults 5 / 1 (Delta taker ~0.05%)
//   --free        ignore fees and slippage entirely
//   --monthly     instead of the 4-variant table, print one calendar-month row
//                 per month over the window, using the LIVE configuration
//                 (published direction, no ATR stop, 10m time stop, 15m cooldown)
//   --months      number of calendar months for --monthly, default 12
//   --invert      with --monthly, use the fade instead of the published mapping
//
//   NOTE: fills are at the signal bar's CLOSE (the stop is intrabar); the live
//   engine enters at market a moment later, so absolute PnL will differ a
//   little. The comparison between the four variants is what this measures.

'use strict';

const { downloadCandles } = require('./lib/data');
const { atr } = require('../src/utils/indicators');

const MA_LEN = 8;

const DEFAULTS = {
  days: 17, atrPeriod: 14, atrMult: 1, timeStop: 10, cooldown: 15,
  notional: 1.0, capital: 10000, fee: 5, slip: 1,
};

// Pine's SMMA (ta.rma). Copied verbatim from the live strategy so a backtested
// cross is the same cross the bot trades.
function smma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts) {
  const { invert, atrPeriod, atrMult, timeStopMin, cooldownMin, notional, capital, costPerLeg } = opts;
  const n = candles.length;

  const O = candles.map((c) => c.open);
  const C = candles.map((c) => c.close);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);

  const closeMA = smma(C, MA_LEN);
  const openMA = smma(O, MA_LEN);
  const atrSeries = atr(candles, atrPeriod);

  const timeStopBars = Math.max(0, Math.round(timeStopMin)); // 1m bars == minutes
  const cooldownBars = Math.max(0, Math.round(cooldownMin));
  const warm = Math.max(MA_LEN + 1, atrPeriod + 1) + 1;

  const trades = [];
  let signals = 0;
  let cooldownSkips = 0;
  let equity = capital;
  let peak = equity;
  let maxDDpct = 0;

  let dir = 0;              // 0 flat, +1 long, -1 short
  let entryPx = 0;
  let entryIdx = 0;
  let stopPx = null;
  let cooldownUntilBar = -Infinity; // entries blocked while bar index < this

  const closeTrade = (exitPx, exitIdx, reason) => {
    const gross = dir * (exitPx / entryPx - 1);
    const net = gross * notional - 2 * costPerLeg * notional;
    equity *= 1 + net;
    trades.push({
      side: dir > 0 ? 'long' : 'short',
      entry: entryPx,
      exit: exitPx,
      net: net * 100,
      bars: exitIdx - entryIdx,
      reason,
      t: candles[entryIdx].time, // entry timestamp (for month bucketing)
    });
    // A losing (gross) close starts the cooldown — the live rule scores the
    // close on the price move, not on fees.
    if (gross < 0 && cooldownBars > 0) cooldownUntilBar = exitIdx + cooldownBars;
    dir = 0;
    stopPx = null;
  };

  const openTrade = (side, px, idx) => {
    dir = side;
    entryPx = px;
    entryIdx = idx;
    stopPx = null;
    if (atrMult > 0 && atrSeries[idx] > 0) {
      const raw = dir > 0 ? px - atrMult * atrSeries[idx] : px + atrMult * atrSeries[idx];
      const losingSide = dir > 0 ? raw < px : raw > px;
      if (losingSide) stopPx = raw;
    }
  };

  for (let i = warm; i < n; i += 1) {
    // 1. resting ATR stop, checked intrabar and filled at the stop price.
    if (dir !== 0 && stopPx != null) {
      const hit = dir > 0 ? L[i] <= stopPx : H[i] >= stopPx;
      if (hit) closeTrade(stopPx, i, 'stop');
    }

    // 2. time stop: flatten once the trade has been open TIME_STOP_MIN bars.
    if (dir !== 0 && timeStopBars > 0 && i - entryIdx >= timeStopBars) {
      closeTrade(C[i], i, 'time');
    }

    // 3. signal on this bar's close.
    if (closeMA[i] == null || closeMA[i - 1] == null || openMA[i] == null || openMA[i - 1] == null) {
      continue;
    }
    const bull = closeMA[i - 1] <= openMA[i - 1] && closeMA[i] > openMA[i];
    const bear = closeMA[i - 1] >= openMA[i - 1] && closeMA[i] < openMA[i];
    if (!bull && !bear) continue;
    signals += 1;

    let desired = 0;
    if (bull) desired = invert ? -1 : 1;
    if (bear) desired = invert ? 1 : -1;

    if (desired !== 0 && desired !== dir) {
      if (dir !== 0) closeTrade(C[i], i, 'reverse'); // the reverse leg
      if (dir === 0 && i >= cooldownUntilBar) openTrade(desired, C[i], i);
      else if (dir === 0) cooldownSkips += 1;
    }

    // mark-to-market drawdown
    if (dir !== 0) {
      const mtm = equity * (1 + dir * (C[i] / entryPx - 1) * notional);
      if (mtm > peak) peak = mtm;
      maxDDpct = Math.max(maxDDpct, ((peak - mtm) / peak) * 100);
    } else if (equity > peak) {
      peak = equity;
    }
  }

  if (dir !== 0) closeTrade(C[n - 1], n - 1, 'eod');

  return { trades, signals, cooldownSkips, equity, capital, maxDDpct };
}

function metrics(candles, opts) {
  const { trades, signals, cooldownSkips, equity, capital, maxDDpct } = simulate(candles, opts);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const base = { spanDays, signals, cooldownSkips, equity, capital, ret: (equity / capital - 1) * 100, maxDDpct };
  if (!trades.length) return { ...base, trades: 0, empty: true };

  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.net > 0);
  const grossWin = sum((t) => Math.max(t.net, 0));
  const grossLoss = Math.abs(sum((t) => Math.min(t.net, 0)));

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgNet: sum((t) => t.net) / n,
    totNet: sum((t) => t.net),
    avgHold: sum((t) => t.bars) / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
  };
}

// ---------------------------------------------------------------------------
// Month-by-month report
// ---------------------------------------------------------------------------

const monthKey = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// Runs the strategy once over the whole 12-month span and buckets every trade
// by the calendar month it was OPENED in, so each month shows what the rule
// actually did inside it (a strategy can be net-flat over a year and still swing
// wildly month to month).
async function monthlyReport(symbols, opts) {
  const { months, atrPeriod, atrMult, timeStop, cooldown, invert, notional, capital, costPerLeg } = opts;
  const now = Math.floor(Date.now() / 1000);
  const dNow = new Date(now * 1000);
  const startMonth = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth() - (months - 1), 1) / 1000;
  const fetchFrom = startMonth - 2 * 86400; // 2 days of indicator warm-up before the window

  console.log(
    `\nOpen Close Cross R5.1 — SMMA(${MA_LEN}) on 1m | month-by-month, last ${months} months\n` +
      `  config : ${invert ? 'fade (INVERT_SIGNALS=true)' : 'published (INVERT_SIGNALS=false)'} | ` +
      `ATR(${atrPeriod})x${atrMult} stop, ${timeStop}m time stop, ${cooldown}m loss cooldown\n` +
      `  costs  : ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps/flip` : 'NONE (--free)'} | ` +
      `notional ${notional}x equity, capital ${capital}`
  );

  for (const symbol of symbols) {
    let candles;
    try {
      ({ candles } = await downloadCandles({ symbol, resolution: '1m', fromSec: fetchFrom, toSec: now }));
    } catch (error) {
      console.log(`\n${symbol}: skipped — ${error.message}`);
      continue;
    }
    if (candles.length < 100) {
      console.log(`\n${symbol}: skipped — only ${candles.length} bars`);
      continue;
    }

    const { trades } = simulate(candles, {
      invert, atrPeriod, atrMult, timeStopMin: timeStop, cooldownMin: cooldown, notional, capital, costPerLeg,
    });

    // keep only trades opened inside the window, then walk them in order so the
    // overall return / drawdown are the real compounded path, not a sum.
    const inWindow = trades.filter((t) => t.t >= startMonth);
    const stats = new Map();
    let eq = 1;
    let peak = 1;
    let maxDD = 0;
    for (const t of inWindow) {
      const key = monthKey(t.t);
      let s = stats.get(key);
      if (!s) { s = { n: 0, wins: 0, totNet: 0, ret: 1 }; stats.set(key, s); }
      s.n += 1;
      if (t.net > 0) s.wins += 1;
      s.totNet += t.net;
      s.ret *= 1 + t.net / 100;
      eq *= 1 + t.net / 100;
      if (eq > peak) peak = eq;
      maxDD = Math.max(maxDD, ((peak - eq) / peak) * 100);
    }

    const days0 = ((candles[candles.length - 1].time - candles[0].time) / 86400).toFixed(0);
    console.log(`\n${symbol}  (${candles.length} bars ~${days0}d, ${inWindow.length} trades in window)`);
    console.log(
      `  ${pad('month', 8)} | ${pad('trades', 6, true)} | ${pad('win%', 5, true)} | ${pad('avg%', 7, true)} | ` +
        `${pad('net%', 8, true)} | ${pad('return%', 8, true)}`
    );
    console.log('  ' + '-'.repeat(57));

    for (let k = 0; k < months; k += 1) {
      const dt = new Date(Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth() - (months - 1) + k, 1));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
      const s = stats.get(key);
      if (!s) {
        console.log(`  ${pad(key, 8)} | ${pad(0, 6, true)} | ${pad('-', 5, true)} | ${pad('-', 7, true)} | ${pad('-', 8, true)} | ${pad('-', 8, true)}`);
        continue;
      }
      console.log(
        `  ${pad(key, 8)} | ${pad(s.n, 6, true)} | ${pad(fmt((s.wins / s.n) * 100, 1), 5, true)} | ` +
          `${pad(signed(s.totNet / s.n, 3), 7, true)} | ${pad(signed(s.totNet, 1), 8, true)} | ${pad(signed((s.ret - 1) * 100, 2), 8, true)}`
      );
    }

    const totalWins = inWindow.filter((t) => t.net > 0).length;
    console.log('  ' + '-'.repeat(57));
    console.log(
      `  ${pad('TOTAL', 8)} | ${pad(inWindow.length, 6, true)} | ` +
        `${pad(inWindow.length ? fmt((totalWins / inWindow.length) * 100, 1) : '-', 5, true)} | ` +
        `${pad(inWindow.length ? signed(inWindow.reduce((s, t) => s + t.net, 0) / inWindow.length, 3) : '-', 7, true)} | ` +
        `${pad(signed(inWindow.reduce((s, t) => s + t.net, 0), 1), 8, true)} | ${pad(signed((eq - 1) * 100, 2), 8, true)}`
    );
    console.log(`  compounded window return ${signed((eq - 1) * 100, 2)}%  |  maxDD (trade-close) ${fmt(maxDD, 1)}%`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

const num = (v, d) => (v !== undefined ? Number(v) : d);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const days = num(args.days, DEFAULTS.days);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'ARIAUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;

  const controls = {
    atrPeriod: num(args['atr-period'], DEFAULTS.atrPeriod),
    atrMult: num(args['atr-mult'], DEFAULTS.atrMult),
    timeStop: num(args['time-stop'], DEFAULTS.timeStop),
    cooldown: num(args.cooldown, DEFAULTS.cooldown),
  };
  const baseOpts = {
    ...controls,
    notional: num(args.notional, DEFAULTS.notional),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
  };

  // --monthly: one calendar-month-bucketed table over the last N months, using
  // the LIVE port's configuration (published direction, ATR stop disabled,
  // TIME_STOP_MIN=10, LOSS_COOLDOWN_MIN=15) unless overridden on the CLI.
  if (args.monthly) {
    await monthlyReport(symbols, {
      months: num(args.months, 12),
      invert: args.invert ? true : false,
      atrPeriod: controls.atrPeriod,
      atrMult: args['atr-mult'] !== undefined ? controls.atrMult : 0, // live ATR_STOP_MULT=0
      timeStop: controls.timeStop,
      cooldown: controls.cooldown,
      notional: baseOpts.notional,
      capital: baseOpts.capital,
      costPerLeg,
    });
    return;
  }

  // baseline / +ATR stop / +ATR+time / +ALL three controls. With
  // --cooldown-sweep the table becomes one row per cooldown length (ATR stop +
  // time stop always on), so longer cooldowns can be compared directly.
  const sweep = args['cooldown-sweep']
    ? String(args['cooldown-sweep']).split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v))
    : null;

  const variants = sweep
    ? sweep.map((minutes) => ({
        label: pad(minutes > 0 ? `cooldown ${minutes}m` : 'no cooldown', 14),
        atrMult: controls.atrMult,
        timeStopMin: controls.timeStop,
        cooldownMin: minutes,
      }))
    : [
        { label: 'baseline      ', atrMult: 0, timeStopMin: 0, cooldownMin: 0 },
        { label: '+ATR stop     ', atrMult: controls.atrMult, timeStopMin: 0, cooldownMin: 0 },
        { label: '+ATR+time     ', atrMult: controls.atrMult, timeStopMin: controls.timeStop, cooldownMin: 0 },
        { label: '+ALL +cooling ', atrMult: controls.atrMult, timeStopMin: controls.timeStop, cooldownMin: controls.cooldown },
      ];

  const cooldownText = sweep ? `cooldown sweep ${sweep.join('/')}m` : `${controls.cooldown}m loss cooldown`;
  console.log(
    `\nOpen Close Cross R5.1 — SMMA(${MA_LEN}) on 1m, last ${days}d | ATR(${controls.atrPeriod})x${controls.atrMult} stop, ` +
      `${controls.timeStop}m time stop, ${cooldownText} | costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps/flip` : 'NONE (--free)'}`
  );

  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;

    let candles;
    try {
      ({ candles } = await downloadCandles({ symbol, resolution: '1m', fromSec, toSec }));
    } catch (error) {
      console.log(`\n${symbol}: skipped — ${error.message}`);
      continue;
    }
    if (candles.length < 100) {
      console.log(`\n${symbol}: skipped — only ${candles.length} bars`);
      continue;
    }

    const days0 = ((candles[candles.length - 1].time - candles[0].time) / 86400).toFixed(1);
    console.log(`\n${symbol}  (${candles.length} bars ~${days0}d)`);
    console.log(
      `  ${pad('direction', 10)} | ${pad('variant', 14)} | ${pad('trades', 6, true)} | ${pad('win%', 5, true)} | ` +
        `${pad('avg%', 7, true)} | ${pad('hold', 5, true)} | ${pad('PF', 5, true)} | ${pad('cooldowns', 9, true)} | ` +
        `${pad('totNet%', 9, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
    );
    console.log('  ' + '-'.repeat(112));

    for (const invert of [true, false]) {
      const direction = invert ? 'fade' : 'published';
      for (const variant of variants) {
        const m = metrics(candles, { ...baseOpts, invert, ...variant });
        if (m.empty) {
          console.log(`  ${pad(direction, 10)} | ${pad(variant.label, 14)} | no trades`);
          continue;
        }
        console.log(
          `  ${pad(direction, 10)} | ${pad(variant.label, 14)} | ${pad(m.trades, 6, true)} | ${pad(fmt(m.winPct, 1), 5, true)} | ` +
            `${pad(signed(m.avgNet, 3), 7, true)} | ${pad(fmt(m.avgHold, 1), 5, true)} | ${pad(fmt(m.profitFactor, 2), 5, true)} | ` +
            `${pad(m.cooldownSkips, 9, true)} | ${pad(signed(m.totNet, 1), 9, true)} | ${pad(signed(m.ret, 2), 9, true)} | ${pad(fmt(m.maxDDpct, 1), 7, true)}`
        );
      }
    }
  }

  console.log(
    '\nfade = live INVERT_SIGNALS=true (bull cross -> short); published = the original R5.1 mapping.\n' +
      'avg%/totNet% are NET of costs on a 1x-equity notional per position; return% compounds the equity.\n' +
      'cooldowns = entries the loss cooldown skipped. Compare the variant rows to isolate each control.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
