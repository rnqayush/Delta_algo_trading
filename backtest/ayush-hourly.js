// "Ayush Hourly Strategy" — SMA(250) cross on BTCUSD 1m, with entry filters.
//
// Base rules:
//   * 250-period SMA; the candle that CROSSES it is the signal candle
//   * stop = (signal candle high - low), capped at `maxSl` points
//   * target = `tpMult` x the stop
//   * only one trade at a time
//
// Filters added for "which zone to wait in, and when to trade":
//   * entryMode 'retest' — instead of chasing the cross close (taker), WAIT for
//     price to come back into the MA zone and fill there as a LIMIT (maker).
//     This is the only filter that lowers the COST line, not just the trade count.
//   * session  — only trade inside a UTC hour window
//   * slopeMin — require the SMA to be sloping in the trade's direction
//   * minSl    — skip signals whose stop is smaller than minSl points
//   * dailyLockUsd — optional "stop once the day is green" brake
//
//   node backtest/ayush-hourly.js --tune --days 7 --tf 1m
//   node backtest/ayush-hourly.js --days 7 --tf 1m --rr 5 --mode retest --session 7-21
//
// Reality rules, same as the rest of the project:
//   * the cross is only known at the CLOSE of its candle, entry fills at that close
//   * a retest limit fills only if price trades back through the MA level
//   * if one bar contains both stop and target, the STOP is assumed first
//   * Delta fees: maker 2 bps / taker 5 bps, + 2 bps adverse slippage on market legs
//   * TP is a resting reduce-only maker limit; only stop-outs pay taker + slippage

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';

const COST = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };
const SIZE = { initialEquity: 1200, riskPct: 0.005, maxNotionalPct: 3, contractValue: 0.001 };

const BASE = {
  tf: '1m',
  sma: 250,
  maxSl: 100,
  stopAtr: 0,      // if > 0, stop = max(candleRange, stopAtr x ATR)
  atrPeriod: 14,
  tpMult: 10,
  minSl: 0,
  entryMode: 'cross', // 'cross' | 'retest'
  retestWindow: 10,
  sessionStart: 0,
  sessionEnd: 24,
  slopeMin: 0,
  slopeLook: 20,
  volMult: 0,
  volLook: 60,
  dailyLockUsd: null,
};

// ---------------------------------------------------------------------------

function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const hourOf = (sec) => new Date(sec * 1000).getUTCHours();

// Wilder ATR — used by the optional ATR-multiple stop.
function atrSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  let prevClose = null;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const tr = prevClose == null
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (i < period) {
      sum += tr;
      if (i === period - 1) out[i] = sum / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
    }
    prevClose = c.close;
  }
  return out;
}

function sizeContracts(entry, slPoints) {
  const byRisk = Math.floor((SIZE.initialEquity * SIZE.riskPct) / (slPoints * SIZE.contractValue));
  const byNotional = Math.floor((SIZE.initialEquity * SIZE.maxNotionalPct) / (entry * SIZE.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

const usdOf = (t) => t.net * (t.contracts || 0) * SIZE.contractValue;

// Delta has no 10m resolution, so 10m is built by pairing two 5m bars.
function aggregate(candles, group, periodSec) {
  let start = candles.findIndex((c) => c.time % periodSec === 0);
  if (start < 0) start = 0;
  const out = [];
  for (let i = start; i + group <= candles.length; i += group) {
    const chunk = candles.slice(i, i + group);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function loadCandles(tf) {
  if (tf === '10m') {
    const base = loadCache(SYMBOL, '5m');
    return base ? { candles: aggregate(base.candles, 2, 600) } : null;
  }
  return loadCache(SYMBOL, tf);
}


// ---------------------------------------------------------------------------

function run(P) {
  const cached = loadCandles(P.tf);
  if (!cached) throw new Error(`No ${P.tf} cache. Run: node backtest/fetch.js --days 60 --timeframes 5m,15m`);

  const candles = cached.candles;
  const n = candles.length;
  const ma = sma(candles.map((c) => c.close), P.sma);
  const atr = P.stopAtr > 0 ? atrSeries(candles, P.atrPeriod) : null;

  const trades = [];
  let pos = null;
  let pending = null;

  const stats = { crosses: 0, skippedSession: 0, skippedSlope: 0, skippedSmall: 0, skippedVol: 0, expired: 0, lockedOut: 0, retestFills: 0 };
  const ranges = [];
  const dayNet = new Map();
  const lockedDays = new Set();

  const makePos = (side, entry, slDist, bar, entryBar, maker) => {
    const dir = side === 'long' ? 1 : -1;
    return {
      side,
      entry,
      slPoints: slDist,
      sl: entry - dir * slDist,
      tp: entry + dir * P.tpMult * slDist,
      entryTime: bar.time,
      entryBar,
      maker,
    };
  };

  const closePos = (exitPrice, bar, why) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (exitPrice - pos.entry) * dir;
    const entryFee = pos.entry * (pos.maker ? COST.maker : COST.taker + COST.slip);
    // take-profit exits are resting reduce-only LIMIT orders => maker, no slippage;
    // stop exits are market => taker + adverse slippage
    const exitMaker = why === 'target';
    const exitFee = exitPrice * (exitMaker ? COST.maker : COST.taker + COST.slip);
    const cost = entryFee + exitFee;
    const net = gross - cost;
    trades.push({
      ...pos,
      exit: exitPrice,
      exitTime: bar.time,
      reason: why,
      gross,
      cost,
      net,
      contracts: sizeContracts(pos.entry, pos.slPoints),
    });
    const d = dayKey(pos.entryTime);
    dayNet.set(d, (dayNet.get(d) || 0) + net);
    if (P.dailyLockUsd != null && dayNet.get(d) > P.dailyLockUsd) lockedDays.add(d);
    pos = null;
  };

  const hitStop = (p, bar) => (p.side === 'long' ? bar.low <= p.sl : bar.high >= p.sl);
  const hitTp = (p, bar) => (p.side === 'long' ? bar.high >= p.tp : bar.low <= p.tp);

  for (let i = P.sma; i < n; i += 1) {
    const bar = candles[i];

    // --- 1. waiting for a retest fill ---
    if (pending) {
      if (i > pending.deadline) {
        pending = null;
        stats.expired += 1;
      } else {
        const touched = pending.side === 'long' ? bar.low <= pending.level : bar.high >= pending.level;
        if (touched) {
          pos = makePos(pending.side, pending.level, pending.slDist, bar, i, true);
          stats.retestFills += 1;
          pending = null;
          // conservative: the fill bar can also stop out
          if (hitStop(pos, bar)) closePos(pos.sl, bar, 'stop');
          else if (hitTp(pos, bar)) closePos(pos.tp, bar, 'target');
        }
      }
    }

    // --- 2. manage an open trade (bars after its entry bar) ---
    if (pos && pos.entryBar < i) {
      if (hitStop(pos, bar)) closePos(pos.sl, bar, 'stop');
      else if (hitTp(pos, bar)) closePos(pos.tp, bar, 'target');
    }

    // --- 3. look for a new signal ---
    if (!pos && !pending) {
      const prev = candles[i - 1];
      const dPrev = prev.close - ma[i - 1];
      const dNow = bar.close - ma[i];
      const long = dPrev <= 0 && dNow > 0;
      const short = dPrev >= 0 && dNow < 0;

      if (long || short) {
        stats.crosses += 1;
        const range = bar.high - bar.low;
        ranges.push(range);

        const slDist = Math.min(
          P.stopAtr > 0 && atr && atr[i] ? Math.max(range, P.stopAtr * atr[i]) : range,
          P.maxSl
        );
        const h = hourOf(bar.time);
        const slope = (ma[i] - ma[i - P.slopeLook]) / P.slopeLook;
        const dir = long ? 1 : -1;

        // volatility gate: the signal candle must be an expansion vs recent range
        let avgRange = 0;
        if (P.volMult > 0) {
          let sum = 0;
          let cnt = 0;
          for (let j = Math.max(P.sma, i - P.volLook); j < i; j += 1) {
            sum += candles[j].high - candles[j].low;
            cnt += 1;
          }
          avgRange = cnt ? sum / cnt : 0;
        }

        if (!(h >= P.sessionStart && h < P.sessionEnd)) stats.skippedSession += 1;
        else if (dir * slope < P.slopeMin) stats.skippedSlope += 1;
        else if (slDist <= 0 || slDist < P.minSl) stats.skippedSmall += 1;
        else if (P.volMult > 0 && avgRange > 0 && range < P.volMult * avgRange) stats.skippedVol += 1;
        else if (lockedDays.has(dayKey(bar.time))) stats.lockedOut += 1;
        else if (P.entryMode === 'retest') {
          pending = { side: long ? 'long' : 'short', level: ma[i], slDist, deadline: i + P.retestWindow };
        } else {
          pos = makePos(long ? 'long' : 'short', bar.close, slDist, bar, i, false);
        }
      }
    }
  }

  // mark any still-open trade to market so the report is complete
  if (pos) {
    const last = candles[n - 1];
    const dir = pos.side === 'long' ? 1 : -1;
    const exitPrice = last.close;
    const gross = (exitPrice - pos.entry) * dir;
    const cost = pos.entry * (pos.maker ? COST.maker : COST.taker + COST.slip) + exitPrice * (COST.taker + COST.slip);
    trades.push({
      ...pos,
      exit: exitPrice,
      exitTime: last.time,
      reason: 'open',
      gross,
      cost,
      net: gross - cost,
      contracts: sizeContracts(pos.entry, pos.slPoints),
    });
  }

  return { candles, ma, trades, stats, ranges };
}

// ---------------------------------------------------------------------------

function windowKeys(candles, days) {
  const keys = [...new Set(candles.map((c) => dayKey(c.time)))];
  return keys.slice(-(days + 1), -1);
}

function summarize(trades, days) {
  const sel = trades.filter((t) => days.includes(dayKey(t.entryTime)));
  const wins = sel.filter((t) => t.net > 0).length;
  const grossUsd = sel.reduce((s, t) => s + t.gross * (t.contracts || 0) * SIZE.contractValue, 0);
  const costUsd = sel.reduce((s, t) => s + t.cost * (t.contracts || 0) * SIZE.contractValue, 0);
  const usd = sel.reduce((s, t) => s + usdOf(t), 0);

  const byDay = new Map();
  for (const t of sel) {
    const d = dayKey(t.entryTime);
    const a = byDay.get(d) || { n: 0, net: 0, usd: 0, w: 0 };
    a.n += 1;
    a.net += t.net;
    a.usd += usdOf(t);
    if (t.net > 0) a.w += 1;
    byDay.set(d, a);
  }
  return {
    n: sel.length,
    wins,
    wr: sel.length ? (wins / sel.length) * 100 : 0,
    grossUsd,
    costUsd,
    usd,
    days: byDay,
    green: [...byDay.values()].filter((a) => a.net > 0).length,
    traded: byDay.size,
  };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { days: 7, tf: '1m', tune: false, rr: null, mode: null, minSl: null, session: null, slope: null, vol: null, lock: null, atr: null, maxSl: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--tf') a.tf = argv[++i];
    else if (k === '--tune') a.tune = true;
    else if (k === '--rr') a.rr = Number(argv[++i]);
    else if (k === '--mode') a.mode = argv[++i];
    else if (k === '--min-sl') a.minSl = Number(argv[++i]);
    else if (k === '--slope') a.slope = Number(argv[++i]);
    else if (k === '--vol') a.vol = Number(argv[++i]);
    else if (k === '--atr') a.atr = Number(argv[++i]);
    else if (k === '--maxsl') a.maxSl = Number(argv[++i]);
    else if (k === '--lock') a.lock = Number(argv[++i]);
    else if (k === '--session') {
      const [s, e] = argv[++i].split('-').map(Number);
      a.session = [s, e];
    }
  }
  return a;
}

function applyArgs(a) {
  const P = { ...BASE, tf: a.tf };
  if (a.rr != null) P.tpMult = a.rr;
  if (a.mode != null) P.entryMode = a.mode;
  if (a.minSl != null) P.minSl = a.minSl;
  if (a.slope != null) P.slopeMin = a.slope;
  if (a.vol != null) P.volMult = a.vol;
  if (a.atr != null) P.stopAtr = a.atr;
  if (a.maxSl != null) P.maxSl = a.maxSl;
  if (a.lock != null) P.dailyLockUsd = a.lock;
  if (a.session != null) [P.sessionStart, P.sessionEnd] = a.session;
  return P;
}

function describe(P) {
  return (
    `tf=${P.tf} mode=${P.entryMode} session=${P.sessionStart}-${P.sessionEnd} ` +
    `slopeMin=${P.slopeMin} volMult=${P.volMult} minSl=${P.minSl} maxSl=${P.maxSl} RR=${P.tpMult}:1 ` +
    `lock=${P.dailyLockUsd == null ? 'off' : '>=' + P.dailyLockUsd}`
  );
}

// ---------------------------------------------------------------------------

function report(P, days) {
  const r = run(P);
  const s = summarize(r.trades, days);
  const usd = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

  console.log(`\n=== ${describe(P)} ===`);
  console.log(`window: ${days.join(', ')}  (${s.traded} trading days, ${s.green} green)`);
  console.log(
    `trades=${s.n}  wins=${s.wins}  losses=${s.n - s.wins}  winRate=${s.wr.toFixed(1)}%  ` +
      `crosses=${r.stats.crosses}  retestFills=${r.stats.retestFills}`
  );
  console.log(
    `skips: session=${r.stats.skippedSession} slope=${r.stats.skippedSlope} ` +
      `vol=${r.stats.skippedVol} smallStop=${r.stats.skippedSmall} expired=${r.stats.expired} locked=${r.stats.lockedOut}`
  );
  console.log(`gross=$${usd(s.grossUsd)}  cost=-$${s.costUsd.toFixed(2)}  net=$${usd(s.usd)}`);
  console.log(
    `equity $${SIZE.initialEquity.toFixed(2)} -> $${(SIZE.initialEquity + s.usd).toFixed(2)}  ` +
      `(${((s.usd / SIZE.initialEquity) * 100).toFixed(2)}%)`
  );

  console.log('\nper-day:');
  console.log('  day         trades  wins     net($)');
  for (const d of days) {
    const a = s.days.get(d);
    if (!a) {
      console.log(`  ${d}  ${String(0).padStart(5)}  ${String(0).padStart(4)}  ${'+0.00'.padStart(9)}`);
      continue;
    }
    console.log(`  ${d}  ${String(a.n).padStart(5)}  ${String(a.w).padStart(4)}  ${usd(a.usd).padStart(9)}`);
  }
  return { r, s };
}

function tune(tf, days) {
  const grid = [];
  for (const entryMode of ['cross', 'retest']) {
    for (const [sessionStart, sessionEnd] of [[0, 24], [7, 21]]) {
      for (const slopeMin of [0, 1, 3]) {
        for (const volMult of [0, 1.5]) {
          for (const minSl of [0, 40]) {
            for (const tpMult of [1, 1.5, 2, 3, 5, 10, 20]) {
              grid.push({ ...BASE, tf, entryMode, sessionStart, sessionEnd, slopeMin, volMult, minSl, tpMult });
            }
          }
        }
      }
    }
  }

  const rows = grid.map((P) => {
    const r = run(P);
    return { P, s: summarize(r.trades, days), r };
  });
  rows.sort((a, b) => b.s.usd - a.s.usd);

  console.log(`\n########## TUNE ${tf} — ${days.length} days (${days[0]} .. ${days[days.length - 1]}) ##########`);
  console.log(`${grid.length} combos, daily lock OFF, ranked by net $:\n`);
  console.log('  RR    mode    session  slope   vol  minSl  trades  wins  win%   green/days    gross$     cost$      net$');
  const d = (x) => ((x >= 0 ? '+' : '') + x.toFixed(2)).padStart(9);
  for (const { P, s } of rows.slice(0, 20)) {
    console.log(
      `  ${String(P.tpMult).padEnd(5)} ${P.entryMode.padEnd(7)} ${String(`${P.sessionStart}-${P.sessionEnd}`).padEnd(7)}  ` +
        `${String(P.slopeMin).padStart(5)}  ${String(P.volMult).padStart(4)}  ${String(P.minSl).padStart(5)}  ${String(s.n).padStart(6)}  ` +
        `${String(s.wins).padStart(4)}  ${s.wr.toFixed(0).padStart(4)}%  ${String(`${s.green}/${s.traded}`).padStart(9)}   ` +
        `${d(s.grossUsd)}  ${d(-s.costUsd)}  ${d(s.usd)}`
    );
  }

  // best per RR, and the effect of each filter group
  console.log('\nbest per RR:');
  for (const rr of [1, 1.5, 2, 3, 5, 10, 20]) {
    const set = rows.filter((x) => x.P.tpMult === rr);
    const best = set[0];
    console.log(
      `  RR ${String(rr).padEnd(5)} net=$${d(best.s.usd).trim().padStart(8)}  ` +
        `(${best.P.entryMode}, session ${best.P.sessionStart}-${best.P.sessionEnd}, slope ${best.P.slopeMin}, minSl ${best.P.minSl}, ` +
        `${best.s.n} trades, ${best.s.wr.toFixed(0)}% win, ${best.s.green}/${best.s.traded} green)`
    );
  }

  const profitable = rows.filter((x) => x.s.usd > 0);
  console.log(`\nprofitable combos: ${profitable.length}/${rows.length}`);
  if (profitable.length) {
    console.log('best:', describe(profitable[0].P), `= $${profitable[0].s.usd.toFixed(2)}`);
  }
}

function main() {
  const a = parseArgs(process.argv);
  const cached = loadCandles(a.tf);
  if (!cached) throw new Error(`No ${a.tf} cache.`);
  const days = windowKeys(cached.candles, a.days);

  console.log(`// Ayush Hourly Strategy — ${SYMBOL} ${a.tf}`);
  console.log(
    `costs: maker ${COST.maker * 1e4}bps / taker ${COST.taker * 1e4}bps + ${COST.slip * 1e4}bps slippage; ` +
      `cross entry ~${((COST.taker + COST.slip) * 2 * 1e4).toFixed(0)}bps round trip, ` +
      `retest entry ~${((COST.maker + COST.taker + COST.slip * 2) * 1e4).toFixed(0)}bps`
  );

  if (a.tune) {
    tune(a.tf, days);
    return;
  }
  report(applyArgs(a), days);
}

main();
