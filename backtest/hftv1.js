// HFTV1 — 1m breakout scalper backtest, two exit models.
//
// Entry (both models, faithful to src/strategies/strategies/hftV1.js):
//   * levels : the previous CLOSED bar's HIGH (upside) and LOW (downside);
//   * a break of the high buys, a break of the low sells; ONE trade per bar.
//
// Exit models (--exit):
//
//   bracket (default) — a stop at STOP_PCT% against the fill and a target at
//     TARGET_PCT% with it, both fixed at entry; whichever is touched first is
//     flattened at market; if neither is touched within MAX_HOLD_BARS candles
//     the trade is flattened on that close (time stop).
//
//   cutloss — the earlier rule: a LOSING trade is flattened the instant the mark
//     is on the wrong side of the fill (so ~breakeven, it exits at the fill),
//     while a WINNING trade is held up to HOLDBARS candles and flattened on the
//     close of the last one.
//
// THE INTRABAR PROBLEM
// --------------------
// A 1m bar does not say in which order its high, low and close happened, so a
// bar that spans both the stop and the target (bracket) or the fill (cutloss)
// cannot be resolved exactly. Rather than pick one guess, this reports the two
// bounds the truth sits between:
//
//   pessimistic the adverse level is assumed hit first — the safe reading.
//               bracket: a bar touching both fills the STOP first.
//               cutloss: the cut fires on ANY adverse tick.
//   optimistic  the friendly reading.
//               bracket: a bar touching both fills the TARGET first.
//               cutloss: the cut only fires if a bar CLOSES adverse.
//
// Entry is decided the same way for both, by ONE documented rule: a bar that
// opens beyond a level has already taken it (fill = open); otherwise the fill is
// the level, and when BOTH levels are live the one NEARER the open is assumed to
// be reached first.
//
//   node backtest/hftv1.js --tf 1m --days 30 --symbols EVAAUSD
//   node backtest/hftv1.js --tf 1m --days 30 --exit cutloss --holdbars 3
//   node backtest/hftv1.js --tf 1m --days 30 --exit bracket --stop 2 --target 6
//
// Options:
//   --symbols   comma-separated (default TRADING_SYMBOL or EVAAUSD)
//   --tf        candle resolution, default 1m
//   --days      look-back window in days, default 30
//   --exit      bracket | cutloss (default bracket)
//   --stop      [bracket] stop distance, percent of the fill, default 2
//   --target    [bracket] target distance, percent, default 6 (keep > --stop)
//   --maxbars   [bracket] candles before the time stop, default 60
//   --holdbars  [cutloss] candles a winner may be held, default 3
//   --mode      optimistic | pessimistic | both (default), default both
//   --size      percent of equity per trade, default 10
//   --capital   starting equity, default 10000
//   --fee       taker fee in bps per leg, default 5 (Delta taker is 0.05%)
//   --slip      slippage in bps per leg, default 1
//   --free      ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 30, exit: 'bracket',
  stop: 2, target: 6, maxbars: 60, // bracket
  holdbars: 3, // cutloss
  mode: 'both', size: 10, capital: 10000, fee: 5, slip: 1, free: false,
};

// Mirror of MIN_BARS in the strategy: a few bars just warm the feed up.
const MIN_BARS = 5;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts, mode) {
  const { costPerLeg, sizePct, capital } = opts;
  const n = candles.length;

  let equity = capital;
  const trades = [];

  let i = MIN_BARS;
  while (i < n) {
    const prev = candles[i - 1];
    const bar = candles[i];

    const up = Number(prev.high); // upside breakout level
    const down = Number(prev.low); // downside breakout level
    const o = Number(bar.open);

    const upReached = Number(bar.high) > up; // price traded through the high
    const downReached = Number(bar.low) < down; // ... and through the low

    // --- which level is taken first, and at what price ---------------------
    let side = null;
    let entry = 0;
    if (o > up) {
      side = 'long';
      entry = o;
    } else if (o < down) {
      side = 'short';
      entry = o;
    } else if (upReached && downReached) {
      if (up - o <= o - down) {
        side = 'long';
        entry = up;
      } else {
        side = 'short';
        entry = down;
      }
    } else if (upReached) {
      side = 'long';
      entry = up;
    } else if (downReached) {
      side = 'short';
      entry = down;
    }
    if (!side) {
      i += 1;
      continue;
    }

    const dir = side === 'long' ? 1 : -1;
    let exit = null;
    let reason = null;
    let exitIdx = i;

    if (opts.exitModel === 'cutloss') {
      // --- cut the loss at the fill, hold a winner up to HOLDBARS ----------
      const lastBar = Math.min(n - 1, i + opts.holdBars - 1);
      exitIdx = lastBar;
      for (let j = i; j <= lastBar; j += 1) {
        const b = candles[j];
        const hi = Number(b.high);
        const lo = Number(b.low);
        const cl = Number(b.close);

        const adverseClose = dir * (cl - entry) < 0;
        const adverseExtreme = dir > 0 ? lo < entry : hi > entry;
        const cut = mode === 'pessimistic' ? adverseExtreme : adverseClose;

        if (cut) {
          exit = entry; // flattened at the fill, ~breakeven
          reason = 'cut';
          exitIdx = j;
          break;
        }
        if (j === lastBar) {
          exit = cl; // never went adverse -> held to the last candle's close
          reason = 'close';
          exitIdx = j;
          break;
        }
      }
      if (exit === null) {
        exit = Number(candles[lastBar].close);
        reason = 'close';
        exitIdx = lastBar;
      }
    } else {
      // --- stop / target bracket fixed at entry ----------------------------
      const stop = entry * (1 - (dir * opts.stopPct) / 100);
      const target = entry * (1 + (dir * opts.targetPct) / 100);
      const lastBar = Math.min(n - 1, i + opts.maxHoldBars);
      exitIdx = lastBar;
      for (let j = i; j <= lastBar; j += 1) {
        const b = candles[j];
        const hi = Number(b.high);
        const lo = Number(b.low);
        const cl = Number(b.close);

        const hitStop = dir > 0 ? lo <= stop : hi >= stop;
        const hitTarget = dir > 0 ? hi >= target : lo <= target;

        if (hitStop && hitTarget) {
          exit = mode === 'pessimistic' ? stop : target;
          reason = mode === 'pessimistic' ? 'stop' : 'target';
          exitIdx = j;
          break;
        }
        if (hitStop) {
          exit = stop;
          reason = 'stop';
          exitIdx = j;
          break;
        }
        if (hitTarget) {
          exit = target;
          reason = 'target';
          exitIdx = j;
          break;
        }
        if (j === lastBar) {
          exit = cl;
          reason = 'time';
          exitIdx = j;
          break;
        }
      }
      if (exit === null) {
        exit = Number(candles[lastBar].close);
        reason = 'time';
        exitIdx = lastBar;
      }
    }

    const grossPct = (dir * (exit - entry)) / entry;
    const netPct = grossPct - costPerLeg * 2;

    const notional = (sizePct / 100) * equity;
    const pnl = notional * netPct;
    equity += pnl;

    trades.push({ side, entry, exit, grossPct, netPct, pnl, reason, time: bar.time });

    // The strategy marks the entry bar as traded and can only enter again on a
    // fresh bar, so resume scanning after the exit bar.
    i = exitIdx + 1;
  }

  return { trades, equity, capital };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts, mode) {
  const { trades, equity, capital } = simulate(candles, opts, mode);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const base = { spanDays, equity, capital, ret: (equity / capital - 1) * 100, mode };
  if (!trades.length) return { ...base, trades: 0, empty: true };

  const sum = (arr, f) => arr.reduce((s, t) => s + f(t), 0);
  const n = trades.length;
  const wins = trades.filter((t) => t.grossPct > 0);
  const losses = trades.filter((t) => t.grossPct < 0);

  const shares = {};
  for (const t of trades) shares[t.reason] = (shares[t.reason] || 0) + 1;
  for (const k of Object.keys(shares)) shares[k] = (shares[k] / n) * 100;

  // Drawdown on the compounding equity curve.
  let eq = capital;
  let peak = capital;
  let maxDDpct = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDDpct) maxDDpct = dd;
  }

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    shares,
    avgWin: wins.length ? (sum(wins, (t) => t.grossPct) / wins.length) * 100 : 0,
    avgLoss: losses.length ? (sum(losses, (t) => t.grossPct) / losses.length) * 100 : 0,
    grossPct: sum(trades, (t) => t.grossPct) * 100,
    netPct: sum(trades, (t) => t.netPct) * 100,
    maxDDpct,
    longShare: (trades.filter((t) => t.side === 'long').length / n) * 100,
  };
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
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const num = (v, d) => (v !== undefined ? Number(v) : d);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tf = args.tf ? String(args.tf) : DEFAULTS.tf;
  if (!RESOLUTION_SECONDS[tf]) {
    console.error(`Unsupported --tf "${tf}". Use one of: ${Object.keys(RESOLUTION_SECONDS).join(', ')}`);
    process.exit(1);
  }

  const exitModel = args.exit ? String(args.exit) : DEFAULTS.exit;
  if (!['bracket', 'cutloss'].includes(exitModel)) {
    console.error('Unsupported --exit. Use bracket | cutloss.');
    process.exit(1);
  }

  const modes = args.mode ? String(args.mode) : DEFAULTS.mode;
  if (!['optimistic', 'pessimistic', 'both'].includes(modes)) {
    console.error('Unsupported --mode. Use optimistic | pessimistic | both.');
    process.exit(1);
  }
  const modeList = modes === 'both' ? ['optimistic', 'pessimistic'] : [modes];

  const days = num(args.days, DEFAULTS.days);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'EVAAUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;

  const opts = {
    exitModel,
    sizePct: num(args.size, DEFAULTS.size),
    capital: num(args.capital, DEFAULTS.capital),
    stopPct: num(args.stop, DEFAULTS.stop),
    targetPct: num(args.target, DEFAULTS.target),
    maxHoldBars: Math.max(1, Math.floor(num(args.maxbars, DEFAULTS.maxbars))),
    holdBars: Math.max(1, Math.floor(num(args.holdbars, DEFAULTS.holdbars))),
    costPerLeg,
  };

  const reasonCols =
    exitModel === 'cutloss'
      ? [['cut', 'cut%'], ['close', 'hold%']]
      : [['stop', 'stop%'], ['target', 'tgt%'], ['time', 'time%']];

  const exitLine =
    exitModel === 'cutloss'
      ? `cut the loss at the fill, hold a winner up to ${opts.holdBars} candle(s)`
      : `stop ${opts.stopPct}% / target ${opts.targetPct}% of the fill, time stop after ${opts.maxHoldBars} candle(s)`;

  console.log(`\nHFTV1 — 1m breakout, ${tf} bars, last ${days}d`);
  console.log('='.repeat(126));
  console.log(
    `model   break of prev ${tf} high -> buy, break of prev low -> sell; one trade per bar; ${exitLine}`
  );
  console.log(
    `sizing  ${opts.sizePct}% of equity per trade, start $${opts.capital}` +
      `   |   costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps per trade round-trip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    let candles = null;
    try {
      ({ candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec }));
    } catch (error) {
      rows.push({ symbol, mode: '-', skipped: error.message });
      continue;
    }
    if (candles.length < 300) {
      rows.push({ symbol, mode: '-', skipped: `only ${candles.length} bars` });
      continue;
    }
    for (const mode of modeList) {
      rows.push({ symbol, bars: candles.length, ...analyze(candles, opts, mode) });
    }
  }

  const reasonHeader = reasonCols.map(([, label]) => `${pad(label, 5, true)}`).join(' | ');
  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('mode', 4)} | ${pad('bars', 6, true)} | ${pad('trades', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('long%', 5, true)} | ${pad('win%', 5, true)} | ${reasonHeader} | ` +
      `${pad('avgWin%', 7, true)} | ${pad('avgLoss%', 8, true)} | ${pad('net%', 8, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(140));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.mode, 4)} | skipped: ${r.skipped}`);
      return;
    }
    const reasonCells = reasonCols.map(([key]) => pad(r.empty ? '-' : fmt(r.shares[key] || 0, 0), 5, true)).join(' | ');
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.mode.slice(0, 3), 4)} | ${pad(r.bars, 6, true)} | ${pad(0, 6, true)} | ` +
          `${pad(fmt(0, 1), 6, true)} | ${pad('-', 5, true)} | ${pad('-', 5, true)} | ${reasonCells} | ` +
          `${pad('-', 7, true)} | ${pad('-', 8, true)} | ${pad('-', 8, true)} | ` +
          `${pad(signed(r.ret, 2), 9, true)} | ${pad('-', 7, true)}`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.mode.slice(0, 3), 4)} | ${pad(r.bars, 6, true)} | ${pad(r.trades, 6, true)} | ` +
        `${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.longShare, 0), 5, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ${reasonCells} | ` +
        `${pad(signed(r.avgWin, 2), 7, true)} | ${pad(signed(r.avgLoss, 2), 8, true)} | ` +
        `${pad(signed(r.netPct, 2), 8, true)} | ${pad(signed(r.ret, 2), 9, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\nopt = optimistic intrabar (adverse level assumed NOT hit first);\n' +
      'pes = pessimistic intrabar (adverse level assumed hit first — the safe reading);\n' +
      'win%  = share whose exit was a profit; the reason columns show how each trade left;\n' +
      'avgWin% / avgLoss% = mean per-trade return on NOTIONAL for the winners / losers;\n' +
      'net%  = summed per-trade return on NOTIONAL over the window, after costs;\n' +
      'return% = actual equity return with the flat sizing, so return% ~= net% x size/100.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
