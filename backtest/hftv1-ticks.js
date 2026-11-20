// HFTV1 — level-armed breakout replayed on a TICK-LEVEL path.
//
// EVAAUSD has no historical tick or sub-minute data on Delta (5s candles are
// served for BTCUSD / ETHUSD only; the REST trade tape is capped at the latest
// 50 prints). So this runs HFTV1's exact rules on a LIQUID instrument using 5s
// candles as the intrabar path — 60x finer than the 1m bars the OHLC backtest
// uses, which shrinks the intrabar ambiguity that made that result swing from
// +285% to -77% on a single assumption.
//
// Entry (faithful to src/strategies/strategies/hftV1.js):
//   * levels : the previous CLOSED 5m candle's HIGH (upside) and LOW (downside),
//     rebuilt by aggregating the 5s series;
//   * a break of the high BUYS, a break of the low SELLS (INVERT_SIGNALS = true);
//   * ONE trade per 5m bar.
//
// Exit — the rule as asked:
//   * the moment the mark is on the WRONG side of the fill the loss is booked at
//     once ("close on immediate loss");
//   * a trade that stays on the right side is held HOLD minutes and then closed
//     on that 5s candle's close ("hold for 5 min if profit").
//
//   node backtest/hftv1-ticks.js --days 30 --symbols BTCUSD,ETHUSD
//   node backtest/hftv1-ticks.js --days 30 --hold 5 --size 10 --capital 10000
//
// THE LEFTOVER AMBIGUITY
// ----------------------
// A 5s bar still does not say whether its high or low came first, so the two
// bounds are reported exactly like the OHLC tool:
//   pessimistic the cut fires on ANY adverse tick (a bar dipping to the fill
//               closes the trade at the fill, ~breakeven) — the safe reading.
//   optimistic  the cut only fires if a bar CLOSES adverse.
// With 5s bars the two should land close together; a wide gap means the rule is
// still path-dependent even at this resolution.

'use strict';

const { getCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  symbols: ['BTCUSD', 'ETHUSD'],
  tf: '5s',
  levelSec: 300, // the level (arming) bar: the previous closed 5m candle
  days: 30,
  holdMin: 5, // hold a winner this long, then close at market
  mode: 'both',
  size: 10, capital: 10000, fee: 5, slip: 1, free: false,
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts, mode) {
  const { costPerLeg, sizePct, capital, levelSec, holdBars } = opts;
  const n = candles.length;

  // --- level bars (5m) rebuilt from the 5s series -------------------------
  const levels = new Map(); // bucketStart -> { high, low }
  const byBucket = new Map(); // bucketStart -> [5s indices, ascending]
  candles.forEach((c, i) => {
    const key = Math.floor(c.time / levelSec) * levelSec;
    let lv = levels.get(key);
    if (!lv) {
      lv = { high: -Infinity, low: Infinity };
      levels.set(key, lv);
    }
    if (Number(c.high) > lv.high) lv.high = Number(c.high);
    if (Number(c.low) < lv.low) lv.low = Number(c.low);

    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(i);
  });
  const keyOrder = [...levels.keys()].sort((a, b) => a - b);
  const keyPos = new Map(keyOrder.map((k, idx) => [k, idx]));

  let equity = capital;
  const trades = [];

  let kp = 1; // arming bar is keyOrder[kp-1]; the trade is taken in keyOrder[kp]
  while (kp < keyOrder.length) {
    const ref = levels.get(keyOrder[kp - 1]);
    const up = ref.high;
    const down = ref.low;
    const idxs = byBucket.get(keyOrder[kp]) || [];

    // --- entry: the first 5s break inside this 5m bar ---------------------
    let side = null;
    let entry = 0;
    let entryIdx = -1;
    for (const i of idxs) {
      const b = candles[i];
      const o = Number(b.open);
      const hi = Number(b.high);
      const lo = Number(b.low);

      if (o > up) {
        side = 'long';
        entry = o;
      } else if (o < down) {
        side = 'short';
        entry = o;
      } else if (hi > up && lo < down) {
        // both levels live -> the one nearer the open is taken first
        if (up - o <= o - down) {
          side = 'long';
          entry = up;
        } else {
          side = 'short';
          entry = down;
        }
      } else if (hi > up) {
        side = 'long';
        entry = up;
      } else if (lo < down) {
        side = 'short';
        entry = down;
      }
      if (side) {
        entryIdx = i;
        break;
      }
    }
    if (!side) {
      kp += 1;
      continue;
    }

    // --- exit: cut an adverse mark at once, else hold HOLD 5s bars ---------
    const dir = side === 'long' ? 1 : -1;
    const lastIdx = Math.min(n - 1, entryIdx + holdBars);
    let exit = null;
    let reason = null;
    let exitIdx = lastIdx;
    for (let j = entryIdx; j <= lastIdx; j += 1) {
      const b = candles[j];
      const hi = Number(b.high);
      const lo = Number(b.low);
      const cl = Number(b.close);

      const adverseClose = dir * (cl - entry) < 0;
      const adverseExtreme = dir > 0 ? lo < entry : hi > entry;
      const cut = mode === 'pessimistic' ? adverseExtreme : adverseClose;

      if (cut) {
        exit = mode === 'pessimistic' ? entry : cl; // cut at the fill (~breakeven) / at the close
        reason = 'cut';
        exitIdx = j;
        break;
      }
      if (j === lastIdx) {
        exit = cl; // stayed friendly the whole hold -> close on the 5s close
        reason = 'hold';
        exitIdx = j;
        break;
      }
    }
    if (exit === null) {
      exit = Number(candles[lastIdx].close);
      reason = 'hold';
      exitIdx = lastIdx;
    }

    const grossPct = (dir * (exit - entry)) / entry;
    const netPct = grossPct - costPerLeg * 2;

    const notional = (sizePct / 100) * equity;
    const pnl = notional * netPct;
    equity += pnl;

    trades.push({ side, entry, exit, grossPct, netPct, pnl, reason, time: candles[entryIdx].time });

    // one trade per level bar: resume after the bar the exit landed in
    const exitKey = Math.floor(candles[exitIdx].time / levelSec) * levelSec;
    const exitPos = keyPos.has(exitKey) ? keyPos.get(exitKey) : keyOrder.length;
    kp = Math.max(kp + 1, exitPos + 1);
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
  const tfSec = RESOLUTION_SECONDS[tf];

  const modes = args.mode ? String(args.mode) : DEFAULTS.mode;
  if (!['optimistic', 'pessimistic', 'both'].includes(modes)) {
    console.error('Unsupported --mode. Use optimistic | pessimistic | both.');
    process.exit(1);
  }
  const modeList = modes === 'both' ? ['optimistic', 'pessimistic'] : [modes];

  const days = num(args.days, DEFAULTS.days);
  const levelSec = Math.max(tfSec, Math.floor(num(args.levelsec, DEFAULTS.levelSec)));
  const holdMin = num(args.hold, DEFAULTS.holdMin);
  const holdBars = Math.max(1, Math.round((holdMin * 60) / tfSec));

  const symbols = (args.symbols ? String(args.symbols).split(',') : DEFAULTS.symbols)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;

  const opts = {
    sizePct: num(args.size, DEFAULTS.size),
    capital: num(args.capital, DEFAULTS.capital),
    levelSec,
    holdBars,
    costPerLeg,
  };

  console.log(`\nHFTV1 — ${tf} path, levels from the prev ${levelSec / 60}m candle, last ${days}d`);
  console.log('='.repeat(126));
  console.log(
    `model   break of prev ${levelSec / 60}m high -> buy, break of prev low -> sell; one trade per ${levelSec / 60}m bar;` +
      ` cut the loss at once, hold a winner ${holdMin}m (${holdBars} x ${tf})`
  );
  console.log(
    `sizing  ${opts.sizePct}% of equity per trade, start $${opts.capital}` +
      `   |   costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps per trade round-trip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    let candles = null;
    let span = '-';
    try {
      ({ candles } = await getCandles({ symbol, resolution: tf, days }));
    } catch (error) {
      rows.push({ symbol, mode: '-', skipped: error.message });
      continue;
    }
    if (candles.length < 1000) {
      rows.push({ symbol, mode: '-', skipped: `only ${candles.length} bars` });
      continue;
    }
    span = `${new Date(candles[0].time * 1000).toISOString().slice(0, 10)}..${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)}`;
    for (const mode of modeList) {
      rows.push({ symbol, span, bars: candles.length, ...analyze(candles, opts, mode) });
    }
  }

  const reasonCols = [['cut', 'cut%'], ['hold', 'hold%']];
  const reasonHeader = reasonCols.map(([, label]) => `${pad(label, 5, true)}`).join(' | ');
  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 8)} | ${pad('mode', 4)} | ${pad('window', 21)} | ${pad('5s bars', 7, true)} | ${pad('trades', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('long%', 5, true)} | ${pad('win%', 5, true)} | ${reasonHeader} | ` +
      `${pad('avgWin%', 7, true)} | ${pad('avgLoss%', 8, true)} | ${pad('net%', 8, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(150));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 8)} | ${pad(r.mode, 4)} | skipped: ${r.skipped}`);
      return;
    }
    const reasonCells = reasonCols.map(([key]) => pad(r.empty ? '-' : fmt(r.shares[key] || 0, 0), 5, true)).join(' | ');
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 8)} | ${pad(r.mode.slice(0, 3), 4)} | ${pad(r.span, 21)} | ${pad(r.bars, 7, true)} | ${pad(0, 6, true)} | ` +
          `${pad(fmt(0, 1), 6, true)} | ${pad('-', 5, true)} | ${pad('-', 5, true)} | ${reasonCells} | ` +
          `${pad('-', 7, true)} | ${pad('-', 8, true)} | ${pad('-', 8, true)} | ` +
          `${pad(signed(r.ret, 2), 9, true)} | ${pad('-', 7, true)}`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 8)} | ${pad(r.mode.slice(0, 3), 4)} | ${pad(r.span, 21)} | ${pad(r.bars, 7, true)} | ${pad(r.trades, 6, true)} | ` +
        `${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.longShare, 0), 5, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ${reasonCells} | ` +
        `${pad(signed(r.avgWin, 2), 7, true)} | ${pad(signed(r.avgLoss, 2), 8, true)} | ` +
        `${pad(signed(r.netPct, 2), 8, true)} | ${pad(signed(r.ret, 2), 9, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\nopt = optimistic intrabar (a 5s bar is only adverse if it CLOSES adverse);\n' +
      'pes = pessimistic intrabar (a 5s bar is adverse if it touches the fill — the safe reading);\n' +
      'cut% = share of trades cut on the first adverse mark; hold% = share held the full window;\n' +
      'avgWin% / avgLoss% = mean per-trade return on NOTIONAL for the winners / losers;\n' +
      'net% = summed per-trade return on NOTIONAL over the window, after costs;\n' +
      'return% = actual equity return with the flat sizing (return% ~= net% x size/100).\n' +
      'A small opt/pes gap means the rule is genuinely resolved at 5s resolution.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
