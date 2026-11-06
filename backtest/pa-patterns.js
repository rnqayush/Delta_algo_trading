// "PA Patterns Strategy v2" (Pine v6) — Engulfing + Morning/Evening Star, ported
// as a backtest.
//
// WHAT IT TRADES
// --------------
//   Bullish Engulfing  -> buy-stop above the engulfing candle's HIGH, SL at the
//                         engulfing LOW (both candles if slWholePattern)
//   Bearish Engulfing  -> sell-stop below its LOW, SL at its HIGH
//   Morning Star       -> buy-stop above the 3rd candle's HIGH, SL at the 3-candle LOW
//   Evening Star       -> sell-stop below the 3rd candle's LOW,  SL at the 3-candle HIGH
//   Exits: TP1 at 1.5R (50% of size) then SL to break-even, TP2 at 2.0R.
//   The pending stop order expires after `validBars` bars if not triggered.
//
// DEVIATIONS FROM THE SOURCE, AND WHY
// -----------------------------------
// 1. POSITION SIZING. The source defaults to a FIXED size of `fixedLots` x
//    `lotSize` = 1 x 65 units — NSE Nifty 50's lot. 65 units of BTCUSD is not a
//    position, it is a hostile takeover, so the fixed-lot path is meaningless on
//    crypto. This port uses the source's OWN risk-sizing branch
//    (`calcQty` with useRiskSizing=true) at `--risk` % of equity per trade, and
//    drops the whole-lot rounding (crypto has no lot).
// 2. MAX TRADES/DAY. The source default is 1, i.e. at most one trade a day.
//    That is a design choice for a 5-hour Nifty session, not a crypto one, so it
//    defaults to unlimited here; run `--maxday 1` for the faithful behaviour.
// 3. TICK SIZE. The source buffers in `syminfo.mintick`. Delta's tick is not in
//    our candle feed, so it is ESTIMATED as the smallest non-zero close-to-close
//    step in the series and printed per symbol.
// 4. Session filter is out of session by default in the source, so it is skipped
//    (crypto trades 24/7); --session <hhmm-hhmm> can re-enable it in UTC.
//
// FAITHFULLY REPRODUCED, INCLUDING ONE BUG
// ----------------------------------------
// The source assigns sigTrig/sigStop in two separate `if bullSig` / `if bearSig`
// blocks. When BOTH fire on the same bar the bear block overwrites the levels,
// yet the long is armed first — so the long inherits the SHORT's trigger and
// stop. That ordering (bull armed first, levels overwritten by bear) is
// reproduced verbatim so the numbers match what TradingView would produce.
//
//   node backtest/pa-patterns.js --tf 5m --days 30 --symbols AINUSD,BTCUSD,ETHUSD
//   node backtest/pa-patterns.js --tf 1m --days 7 --symbols AINUSD,BTCUSD,ETHUSD
//   node backtest/pa-patterns.js --tf 5m --days 30 --maxday 1 --fee 5 --slip 2
//
// Options:
//   --symbols    comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf         candle resolution, default 5m
//   --days       look-back window in days, default 30
//   --patterns   eng | star | both, default both
//   --validbars  pending entry validity in bars, default 5
//   --entrybuf   entry buffer in ticks, default 2
//   --slbuf      SL buffer in ticks, default 2
//   --minstop    minimum stop distance in ticks, default 5
//   --nostructsl engulfing SL from the last candle only (source: both)
//   --tp1r/--tp2r  TP1 / TP2 R multiples, defaults 1.5 / 2.0
//   --tp1qty     TP1 size as % of position, default 50
//   --nobe       do not move SL to break-even after TP1
//   --beoffset   break-even offset in ticks, default 2
//   --maxday     max trades per day (0 = unlimited), default 0
//   --maxloss    stop after N losses in a day (0 = off), default 0
//   --risk       risk per trade as % of equity, default 1.0
//   --capital    starting equity, default 10000
//   --fee/--slip bps per leg, defaults 3 / 1 (source: 0.03% + 1 tick)
//   --free       ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '5m', days: 30, patterns: 'both', validbars: 5,
  entrybuf: 2, slbuf: 2, minstop: 5, structSL: true,
  tp1r: 1.5, tp2r: 2.0, tp1qty: 50, moveBE: true, beoffset: 2, useTP1: true,
  maxday: 0, maxloss: 0, risk: 1.0, capital: 10000,
  fee: 3, slip: 1, free: false,
  // pattern shape thresholds (source defaults)
  minEngBodyPct: 50, strictEng: true, engNeedClose: true,
  smallBodyPct: 35, strongBodyPct: 55, penetrationPct: 50,
};

function emaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (!(len > 0) || n < len) return out;
  const k = 2 / (len + 1);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// The smallest non-zero close-to-close step, i.e. the instrument's price grid.
function estimateTick(candles) {
  let best = Infinity;
  for (let i = 1; i < candles.length; i += 1) {
    const d = Math.abs(candles[i].close - candles[i - 1].close);
    if (d > 1e-15 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 1e-8;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts) {
  const {
    useEng, useStar, minEngBodyPct, strictEng, engNeedClose, smallBodyPct,
    strongBodyPct, penetrationPct, validBars, entryBuf, slBuf, minStopTicks,
    structSL, tp1R, tp2R, tp1Qty, useTP1, moveBE, beOffset, maxDay, maxLoss,
    riskPct, capital, costPerLeg, tick,
  } = opts;

  const n = candles.length;
  const O = candles.map((c) => c.open);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const C = candles.map((c) => c.close);

  let equity = capital;
  let peak = equity;
  let maxDDpct = 0;

  const trades = [];
  let signals = 0;

  let pending = null; // { dir, trig, stop, name, armBar }
  let pos = null;     // { dir, entry, stop, R, units, exitedUnits, proceeds, tp1Done }

  let day = null;
  let tradesToday = 0;
  let lossesToday = 0;

  const pay = (price, qty, index) => {
    pos.exitedUnits += qty;
    pos.proceeds += qty * price;
    return { price, qty, index };
  };

  const finish = (index, reason) => {
    const d = pos.dir;
    const gross = d * (pos.proceeds - pos.entry * pos.exitedUnits);
    const cost = costPerLeg * (pos.entry * pos.exitedUnits + pos.proceeds);
    const pnl = gross - cost;
    const riskRs = pos.R * pos.units;
    equity += pnl;
    if (equity > peak) peak = equity;
    maxDDpct = Math.max(maxDDpct, ((peak - equity) / peak) * 100);
    const exitAvg = pos.proceeds / pos.exitedUnits;
    trades.push({
      side: d > 0 ? 'long' : 'short',
      entry: pos.entry,
      exit: exitAvg,
      R: pos.R,
      pnl,
      rMult: riskRs > 0 ? pnl / riskRs : 0,
      bars: index - pos.entryIndex,
      reason,
      time: candles[index].time,
    });
    if (pnl < 0) lossesToday += 1;
    pos = null;
  };

  for (let i = 2; i < n; i += 1) {
    // --- day rollover -----------------------------------------------------
    const curDay = Math.floor(candles[i].time / 86400);
    if (day === null) day = curDay;
    if (curDay !== day) {
      day = curDay;
      tradesToday = 0;
      lossesToday = 0;
    }
    const dayLimitHit = (maxDay > 0 && tradesToday >= maxDay) || (maxLoss > 0 && lossesToday >= maxLoss);

    // --- 1. pending entry order: fill check, then expiry --------------------
    if (pending) {
      const bar = candles[i];
      const longFill = pending.dir === 1 ? bar.high >= pending.trig : bar.low <= pending.trig;
      if (longFill && dayLimitHit === false) {
        // resting stop: fills at the trigger, or at the open if the bar gapped through it
        const entry = pending.dir === 1 ? (bar.open > pending.trig ? bar.open : pending.trig)
          : (bar.open < pending.trig ? bar.open : pending.trig);
        const R = Math.abs(entry - pending.stop);
        if (R > 0) {
          pos = {
            dir: pending.dir,
            entry,
            stop: pending.stop,
            R,
            units: (riskPct / 100) * equity / R,
            exitedUnits: 0,
            proceeds: 0,
            tp1Done: false,
            entryIndex: i,
          };
          tradesToday += 1;
          pending = null;
        }
      } else if (i - pending.armBar > validBars) {
        pending = null;
      }
    }

    // --- 2. manage the open position ---------------------------------------
    if (pos) {
      const bar = candles[i];
      const d = pos.dir;
      const tp1Px = pos.entry + d * pos.R * tp1R;
      const tp2Px = pos.entry + d * pos.R * tp2R;
      const slHit = d === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const tp1Hit = d === 1 ? bar.high >= tp1Px : bar.low <= tp1Px;
      const tp2Hit = d === 1 ? bar.high >= tp2Px : bar.low <= tp2Px;

      // gap handling: a stop opening beyond its level fills at the open.
      const slPrice = d === 1 ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open);

      if (useTP1 && !pos.tp1Done) {
        if (slHit) {
          pay(slPrice, pos.units, i);
          finish(i, 'sl');
        } else if (tp1Hit) {
          const tp1Price = d === 1 ? Math.max(tp1Px, bar.open) : Math.min(tp1Px, bar.open);
          const q = (pos.units * tp1Qty) / 100;
          pay(tp1Price, q, i);
          pos.tp1Done = true;
          if (moveBE) pos.stop = pos.entry + d * beOffset * tick;
          const beHit = d === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
          if (beHit) {
            pay(pos.stop, pos.units - q, i);
            finish(i, 'be');
          } else if (tp2Hit) {
            const tp2Price = d === 1 ? Math.max(tp2Px, bar.open) : Math.min(tp2Px, bar.open);
            pay(tp2Price, pos.units - q, i);
            finish(i, 'tp2');
          }
        }
      } else if (slHit) {
        pay(slPrice, pos.units - pos.exitedUnits, i);
        finish(i, 'sl');
      } else if (tp2Hit) {
        const tp2Price = d === 1 ? Math.max(tp2Px, bar.open) : Math.min(tp2Px, bar.open);
        pay(tp2Price, pos.units - pos.exitedUnits, i);
        finish(i, 'tp2');
      }
    }

    // --- 3. pattern detection on this bar's close ---------------------------
    const o = O[i]; const c = C[i]; const h = H[i]; const l = L[i];
    const o1 = O[i - 1]; const c1 = C[i - 1]; const h1 = H[i - 1]; const l1 = L[i - 1];
    const o2 = O[i - 2]; const c2 = C[i - 2]; const h2 = H[i - 2]; const l2 = L[i - 2];

    const body0 = Math.abs(c - o); const body1 = Math.abs(c1 - o1); const body2 = Math.abs(c2 - o2);
    const rng0 = h - l; const rng1 = h1 - l1; const rng2 = h2 - l2;
    const bodyPct0 = rng0 > 0 ? (body0 / rng0) * 100 : 0;
    const bodyPct1 = rng1 > 0 ? (body1 / rng1) * 100 : 0;
    const bodyPct2 = rng2 > 0 ? (body2 / rng2) * 100 : 0;

    const bull0 = c > o; const bear0 = c < o;
    const bull1 = c1 > o1; const bear1 = c1 < o1;
    const bull2 = c2 > o2; const bear2 = c2 < o2;

    const engBodyOK = bodyPct0 >= minEngBodyPct;
    const bullEngRaw = useEng && bear1 && bull0 && engBodyOK &&
      (strictEng ? (o < c1 && c > o1) : (o <= c1 && c >= o1)) && (!engNeedClose || c > o1);
    const bearEngRaw = useEng && bull1 && bear0 && engBodyOK &&
      (strictEng ? (o > c1 && c < o1) : (o >= c1 && c <= o1)) && (!engNeedClose || c < o1);

    const smallMiddle = bodyPct1 <= smallBodyPct;
    const strongFirst = bodyPct2 >= strongBodyPct;
    const strongThird = bodyPct0 >= strongBodyPct;
    const midBull = o2 - body2 * (penetrationPct / 100);
    const midBear = o2 + body2 * (penetrationPct / 100);
    const morningRaw = useStar && bear2 && smallMiddle && strongFirst && bull0 && strongThird && c > midBull;
    const eveningRaw = useStar && bull2 && smallMiddle && strongFirst && bear0 && strongThird && c < midBear;

    const bullSig = bullEngRaw || morningRaw;
    const bearSig = bearEngRaw || eveningRaw;
    if (bullSig || bearSig) signals += 1;

    // --- 4. levels (replicating the source's overwrite ordering) -----------
    let sigTrig = null;
    let sigStop = null;
    if (bullSig) {
      sigTrig = h + entryBuf * tick;
      sigStop = (morningRaw ? Math.min(l, l1, l2) : structSL ? Math.min(l, l1) : l) - slBuf * tick;
      if (sigTrig - sigStop < minStopTicks * tick) sigStop = sigTrig - minStopTicks * tick;
    }
    if (bearSig) {
      sigTrig = l - entryBuf * tick;
      sigStop = (eveningRaw ? Math.max(h, h1, h2) : structSL ? Math.max(h, h1) : h) + slBuf * tick;
      if (sigStop - sigTrig < minStopTicks * tick) sigStop = sigTrig + minStopTicks * tick;
    }

    // --- 5. arm a pending setup -------------------------------------------
    const flat = pos === null;
    const canArm = flat && pending === null && !dayLimitHit;
    if (canArm && bullSig && sigTrig != null) {
      pending = { dir: 1, trig: sigTrig, stop: sigStop, name: morningRaw ? 'Morning Star' : 'Bullish Engulfing', armBar: i };
    } else if (canArm && bearSig && sigTrig != null && pending === null) {
      pending = { dir: -1, trig: sigTrig, stop: sigStop, name: eveningRaw ? 'Evening Star' : 'Bearish Engulfing', armBar: i };
    }
  }

  return { trades, signals, equity, capital, maxDDpct };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts) {
  const { trades, signals, equity, capital, maxDDpct } = simulate(candles, opts);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const base = { spanDays, signals, equity, capital, ret: (equity / capital - 1) * 100, maxDDpct };
  if (!trades.length) return { ...base, trades: 0, empty: true };

  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = sum((t) => Math.max(t.pnl + 0, 0));
  const grossLoss = Math.abs(sum((t) => Math.min(t.pnl, 0)));

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgR: sum((t) => t.rMult) / n,
    totR: sum((t) => t.rMult),
    avgHold: sum((t) => t.bars) / n,
    tp2Share: (trades.filter((t) => t.reason === 'tp2').length / n) * 100,
    slShare: (trades.filter((t) => t.reason === 'sl' || t.reason === 'be').length / n) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
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

  const days = num(args.days, DEFAULTS.days);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const pat = (args.patterns ? String(args.patterns) : DEFAULTS.patterns).toLowerCase();
  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = DEFAULTS.free || args.free ? 0 : fee + slip;

  const baseOpts = {
    useEng: pat === 'eng' || pat === 'both',
    useStar: pat === 'star' || pat === 'both',
    minEngBodyPct: DEFAULTS.minEngBodyPct,
    strictEng: DEFAULTS.strictEng,
    engNeedClose: DEFAULTS.engNeedClose,
    smallBodyPct: DEFAULTS.smallBodyPct,
    strongBodyPct: DEFAULTS.strongBodyPct,
    penetrationPct: DEFAULTS.penetrationPct,
    validBars: num(args.validbars, DEFAULTS.validbars),
    entryBuf: num(args.entrybuf, DEFAULTS.entrybuf),
    slBuf: num(args.slbuf, DEFAULTS.slbuf),
    minStopTicks: num(args.minstop, DEFAULTS.minstop),
    structSL: !args.nostructsl,
    tp1R: num(args.tp1r, DEFAULTS.tp1r),
    tp2R: num(args.tp2r, DEFAULTS.tp2r),
    tp1Qty: num(args.tp1qty, DEFAULTS.tp1qty),
    useTP1: !args.notp1,
    moveBE: !args.nobe,
    beOffset: num(args.beoffset, DEFAULTS.beoffset),
    maxDay: num(args.maxday, DEFAULTS.maxday),
    maxLoss: num(args.maxloss, DEFAULTS.maxloss),
    riskPct: num(args.risk, DEFAULTS.risk),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
  };

  console.log(`\nPA Patterns v2 (Engulfing + Star) — ${tf} bars, last ${days}d`);
  console.log('='.repeat(122));
  console.log(
    `model   patterns=${pat}, stop order on break (valid ${baseOpts.validBars} bars), SL=${baseOpts.structSL ? 'structure' : 'last candle'}, ` +
      `TP1 ${baseOpts.tp1R}R (${baseOpts.tp1Qty}%)${baseOpts.moveBE ? ' -> BE' : ''}, TP2 ${baseOpts.tp2R}R`
  );
  console.log(
    `sizing  risk ${baseOpts.riskPct}% of equity/trade (source default is 65-unit lots), ` +
      `max ${baseOpts.maxDay > 0 ? baseOpts.maxDay : 'unlimited'} trades/day (source: 1)` +
      `   |   costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps/trade` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 50) {
        rows.push({ symbol, skipped: `only ${candles.length} bars` });
        continue;
      }
      const tick = estimateTick(candles);
      rows.push({ symbol, bars: candles.length, tick, ...analyze(candles, { ...baseOpts, tick }) });
    } catch (error) {
      rows.push({ symbol, skipped: error.message });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('tick', 9, true)} | ${pad('sigs', 5, true)} | ` +
      `${pad('trades', 6, true)} | ${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('avgR', 6, true)} | ` +
      `${pad('totR', 7, true)} | ${pad('PF', 5, true)} | ${pad('sl%', 5, true)} | ${pad('tp2%', 5, true)} | ` +
      `${pad('return%', 8, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(140));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`);
      return;
    }
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.tick.toExponential(1), 9, true)} | ` +
          `${pad(r.signals, 5, true)} | no trades            ${pad(signed(r.ret, 2), 8, true)}`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.tick.toExponential(1), 9, true)} | ` +
        `${pad(r.signals, 5, true)} | ${pad(r.trades, 6, true)} | ${pad(fmt(r.perDay, 1), 6, true)} | ` +
        `${pad(fmt(r.winPct, 1), 5, true)} | ${pad(signed(r.avgR, 2), 6, true)} | ${pad(signed(r.totR, 1), 7, true)} | ` +
        `${pad(fmt(r.profitFactor, 2), 5, true)} | ${pad(fmt(r.slShare, 0), 5, true)} | ${pad(fmt(r.tp2Share, 0), 5, true)} | ` +
        `${pad(signed(r.ret, 2), 8, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\nsigs = bars with a pattern, trades = entries filled; totR = sum of R multiples at the stated risk sizing;\n' +
      'sl% = exits stopped out (incl. break-even stops), tp2% = exits that reached the final target;\n' +
      'PF is computed on net PnL. return% is the equity return over the window at the configured risk per trade.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
