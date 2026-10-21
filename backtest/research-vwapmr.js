// VWAP mean-reversion research — fade a stretch away from the session VWAP on
// 1m / 5m only. Built because the SMA(250) cross has ~zero gross edge at these
// speeds, so the only way to clear the fee wall is a setup whose entries AND
// exits are maker fills.
//
// Setup:
//   * session VWAP (anchored at 00:00 UTC)
//   * signal: close stretched >= devMult x ATR(14) away from VWAP
//   * entry : LIMIT at the signal-bar close (maker) — you are the counterparty
//             to the spike, which is the realistic fill for a fade
//   * target: the VWAP level itself (reduce-only LIMIT => maker)
//   * stop  : slMult x ATR beyond entry (market => taker + slippage)
//   * time  : exit after maxBars if neither is hit (market)
//
// Noise filters ("which zone to wait, when to trade"):
//   * session window (UTC hours) + skip the first startMin minutes of the day
//   * adxMax — mean reversion wants a QUIET tape, so trade only when ADX <= adxMax
//   * erMax  — same idea via Kaufman efficiency ratio
//   * cooldown — min bars between trades
//
//   node backtest/research-vwapmr.js --tune --tf 5m --days 45
//   node backtest/research-vwapmr.js --tf 5m --days 45 --dev 2 --sl 1 --session 7-21

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';

const COST = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };
const SIZE = { initialEquity: 1200, riskPct: 0.005, maxNotionalPct: 3, contractValue: 0.001 };

const BASE = {
  tf: '5m',
  atrPeriod: 14,
  devMult: 2,      // enter when |close - vwap| >= devMult x ATR
  slMult: 1,       // stop distance in ATR
  tpMode: 'vwap',  // 'vwap' | 'atr'
  tpMult: 1,       // used when tpMode = 'atr'
  maxBars: 48,     // time-stop in bars
  sessionStart: 0,
  sessionEnd: 24,
  startMin: 0,     // skip first N minutes of the UTC day
  adxPeriod: 14,
  adxMax: 100,     // require ADX <= adxMax
  erPeriod: 10,
  erMax: 1,        // require ER <= erMax
  cooldown: 0,
};

// ---------------------------------------------------------------------------
// indicators

const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const hourOf = (sec) => new Date(sec * 1000).getUTCHours();
const minOfDay = (sec) => {
  const d = new Date(sec * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

function vwapSeries(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let day = null;
  let pv = 0;
  let v = 0;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const d = dayKey(c.time);
    if (d !== day) { day = d; pv = 0; v = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    v += c.volume;
    out[i] = v ? pv / v : c.close;
  }
  return out;
}

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

function adxSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let trS = 0;
  let pdmS = 0;
  let ndmS = 0;
  let adx = null;
  const dxVals = [];
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    let tr;
    let pdm = 0;
    let ndm = 0;
    if (i === 0) {
      tr = c.high - c.low;
    } else {
      const p = candles[i - 1];
      const up = c.high - p.high;
      const dn = p.low - c.low;
      pdm = up > dn && up > 0 ? up : 0;
      ndm = dn > up && dn > 0 ? dn : 0;
      tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    if (i < period) {
      trS += tr; pdmS += pdm; ndmS += ndm;
    } else {
      trS = trS - trS / period + tr;
      pdmS = pdmS - pdmS / period + pdm;
      ndmS = ndmS - ndmS / period + ndm;
    }
    if (i >= period && trS > 0) {
      const pdi = (100 * pdmS) / trS;
      const ndi = (100 * ndmS) / trS;
      const sum = pdi + ndi;
      const dx = sum ? (100 * Math.abs(pdi - ndi)) / sum : 0;
      if (adx == null) {
        dxVals.push(dx);
        if (dxVals.length === period) {
          adx = dxVals.reduce((a, b) => a + b, 0) / period;
          out[i] = adx;
        }
      } else {
        adx = (adx * (period - 1) + dx) / period;
        out[i] = adx;
      }
    }
  }
  return out;
}

function erSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    const change = Math.abs(candles[i].close - candles[i - period].close);
    let vol = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      vol += Math.abs(candles[j].close - candles[j - 1].close);
    }
    out[i] = vol ? change / vol : 0;
  }
  return out;
}

function prepare(tf) {
  const cached = loadCache(SYMBOL, tf);
  if (!cached) throw new Error(`No ${tf} cache. Run: node backtest/fetch.js --days 60 --timeframes 1m,5m`);
  const candles = cached.candles;
  return {
    candles,
    vwap: vwapSeries(candles),
    atr: atrSeries(candles, BASE.atrPeriod),
    adx: adxSeries(candles, BASE.adxPeriod),
    er: erSeries(candles, BASE.erPeriod),
  };
}

// ---------------------------------------------------------------------------

function sizeContracts(entry, slPoints) {
  const byRisk = Math.floor((SIZE.initialEquity * SIZE.riskPct) / (slPoints * SIZE.contractValue));
  const byNotional = Math.floor((SIZE.initialEquity * SIZE.maxNotionalPct) / (entry * SIZE.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function run(P, data) {
  const { candles, vwap, atr, adx, er } = data;
  const n = candles.length;

  const trades = [];
  const dayNet = new Map();
  const stats = { signals: 0, skippedSession: 0, skippedAdx: 0, skippedEr: 0, skippedCooldown: 0, skippedTarget: 0 };
  let pos = null;
  let lastExitBar = -1e9;
  let warm = Math.max(P.atrPeriod * 3, P.adxPeriod * 2 + 2, P.erPeriod + 2, 260);

  const closePos = (price, i, why) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - pos.entry) * dir;
    const entryFee = pos.entry * COST.maker;
    const exitMaker = why === 'target';
    const exitFee = price * (exitMaker ? COST.maker : COST.taker + COST.slip);
    const net = gross - (entryFee + exitFee);
    const contracts = sizeContracts(pos.entry, pos.slDist);
    const usd = net * contracts * SIZE.contractValue;
    const costUsd = (entryFee + exitFee) * contracts * SIZE.contractValue;
    trades.push({ side: pos.side, why, net, contracts, usd, costUsd, entryBar: pos.entryBar, exitBar: i });
    pos = null;
    lastExitBar = i;
    const k = dayKey(candles[i].time);
    dayNet.set(k, (dayNet.get(k) || 0) + usd);
  };

  for (let i = warm; i < n; i += 1) {
    const bar = candles[i];

    if (pos && i > pos.entryBar) {
      const dir = pos.side === 'long' ? 1 : -1;
      const stopHit = dir === 1 ? bar.low <= pos.sl : bar.high >= pos.sl;
      const tpHit = dir === 1 ? bar.high >= pos.tp : bar.low <= pos.tp;
      if (stopHit) closePos(pos.sl, i, 'stop');
      else if (tpHit) closePos(pos.tp, i, 'target');
      else if (i - pos.entryBar >= P.maxBars) closePos(bar.close, i, 'time');
    }
    if (pos) continue;

    if (i - lastExitBar < P.cooldown) { stats.skippedCooldown += 1; continue; }

    const a = atr[i];
    if (!a || a <= 0 || vwap[i] == null) continue;

    const dev = bar.close - vwap[i];
    let side = null;
    if (dev <= -P.devMult * a) side = 'long';
    else if (dev >= P.devMult * a) side = 'short';
    if (!side) continue;
    stats.signals += 1;

    if (!(hourOf(bar.time) >= P.sessionStart && hourOf(bar.time) < P.sessionEnd)) { stats.skippedSession += 1; continue; }
    if (minOfDay(bar.time) < P.startMin) { stats.skippedSession += 1; continue; }
    if (adx[i] == null || adx[i] > P.adxMax) { stats.skippedAdx += 1; continue; }
    if (er[i] == null || er[i] > P.erMax) { stats.skippedEr += 1; continue; }

    const dir = side === 'long' ? 1 : -1;
    const entry = bar.close;
    const slDist = P.slMult * a;
    if (slDist <= 0) continue;
    const sl = entry - dir * slDist;
    const tp = P.tpMode === 'vwap' ? vwap[i] : entry + dir * P.tpMult * a;
    if (dir * (tp - entry) <= 0) { stats.skippedTarget += 1; continue; }

    pos = { side, entry, sl, tp, slDist, entryBar: i };
  }

  if (pos) closePos(candles[n - 1].close, n - 1, 'time');

  return { trades, dayNet, stats };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// reporting

function windowKeys(candles, days) {
  const keys = [...new Set(candles.map((c) => dayKey(c.time)))].sort();
  return new Set(keys.slice(-(days + 1), -1));
}

function report(P, data, days) {
  const win = windowKeys(data.candles, days);
  const res = run(P, data);
  const kept = res.trades.filter((t) => win.has(dayKey(data.candles[t.exitBar].time)));
  const dayNet = new Map();
  for (const t of kept) {
    const k = dayKey(data.candles[t.exitBar].time);
    dayNet.set(k, (dayNet.get(k) || 0) + t.usd);
  }
  const rows = [...win].map((k) => ({
    day: k,
    net: dayNet.get(k) || 0,
    n: kept.filter((t) => dayKey(data.candles[t.exitBar].time) === k).length,
    w: kept.filter((t) => dayKey(data.candles[t.exitBar].time) === k && t.net > 0).length,
  }));

  const grossUsd = kept.reduce((s, t) => s + t.usd + t.costUsd, 0);
  const costUsd = kept.reduce((s, t) => s + t.costUsd, 0);
  const netUsd = kept.reduce((s, t) => s + t.usd, 0);
  const wins = kept.filter((t) => t.net > 0).length;
  const green = rows.filter((r) => r.net > 0).length;
  const traded = rows.filter((r) => r.n > 0).length;

  console.log(
    `\n=== tf=${P.tf} dev=${P.devMult}xATR sl=${P.slMult}xATR tp=${P.tpMode} maxBars=${P.maxBars} ` +
      `session=${P.sessionStart}-${P.sessionEnd} startMin=${P.startMin} adxMax=${P.adxMax} erMax=${P.erMax} cooldown=${P.cooldown} ===`
  );
  console.log(`window: ${[...win][0]} .. ${[...win][win.length - 1]} (${traded} trading days, ${green} green)`);
  console.log(
    `trades=${kept.length}  wins=${wins}  winRate=${kept.length ? ((wins / kept.length) * 100).toFixed(1) : '0.0'}%  ` +
      `signals=${res.stats.signals}`
  );
  console.log(
    `skips: session=${res.stats.skippedSession} adx=${res.stats.skippedAdx} er=${res.stats.skippedEr} ` +
      `cooldown=${res.stats.skippedCooldown} badTarget=${res.stats.skippedTarget}`
  );
  console.log(`gross=$+${grossUsd.toFixed(2)}  cost=-$${costUsd.toFixed(2)}  net=$${(netUsd >= 0 ? '+' : '') + netUsd.toFixed(2)}`);
  console.log(
    `equity $${SIZE.initialEquity.toFixed(2)} -> $${(SIZE.initialEquity + netUsd).toFixed(2)}  ` +
      `(${((netUsd / SIZE.initialEquity) * 100).toFixed(2)}%)`
  );
  console.log('\nper-day:');
  console.log('  day         trades  wins     net($)');
  for (const r of rows) {
    console.log(
      `  ${r.day}  ${String(r.n).padStart(5)}  ${String(r.w).padStart(4)}  ${((r.net >= 0 ? '+' : '') + r.net.toFixed(2)).padStart(9)}`
    );
  }
}

// ---------------------------------------------------------------------------
// tune

function tune(tf, days, data) {
  const win = windowKeys(data.candles, days);
  const grid = [];
  for (const devMult of [1.5, 2, 2.5, 3]) {
    for (const slMult of [0.75, 1, 1.5]) {
      for (const adxMax of [100, 30, 25]) {
        for (const erMax of [1, 0.5, 0.35]) {
          for (const [sessionStart, sessionEnd] of [[0, 24], [7, 21]]) {
            for (const maxBars of [24, 48, 96]) {
              grid.push({ ...BASE, tf, devMult, slMult, adxMax, erMax, sessionStart, sessionEnd, maxBars });
            }
          }
        }
      }
    }
  }

  const rows = grid.map((P) => {
    const res = run(P, data);
    const kept = res.trades.filter((t) => win.has(dayKey(data.candles[t.exitBar].time)));
    const net = kept.reduce((s, t) => s + t.usd, 0);
    const gross = kept.reduce((s, t) => s + t.usd + t.costUsd, 0);
    const cost = kept.reduce((s, t) => s + t.costUsd, 0);
    const wins = kept.filter((t) => t.net > 0).length;
    const dayNet = new Map();
    for (const t of kept) {
      const k = dayKey(data.candles[t.exitBar].time);
      dayNet.set(k, (dayNet.get(k) || 0) + t.usd);
    }
    return { P, s: { n: kept.length, wins, usd: net, grossUsd: gross, costUsd: cost, green: [...dayNet.values()].filter((v) => v > 0).length, traded: dayNet.size } };
  });

  rows.sort((a, b) => b.s.usd - a.s.usd);
  const profits = rows.filter((r) => r.s.usd > 0).length;

  console.log(`\n########## TUNE ${tf} — ${days} days, VWAP mean-reversion ##########`);
  console.log(`${rows.length} combos, ranked by net $:\n`);
  console.log('  dev  sl   adxMax  erMax  session  maxBars  trades  win%   green/days    gross$     cost$      net$');
  const d = (x) => ((x >= 0 ? '+' : '') + x.toFixed(2)).padStart(9);
  for (const { P, s } of rows.slice(0, 20)) {
    console.log(
      `  ${String(P.devMult).padEnd(4)} ${String(P.slMult).padEnd(4)} ${String(P.adxMax).padStart(6)}  ` +
        `${String(P.erMax).padStart(5)}  ${String(`${P.sessionStart}-${P.sessionEnd}`).padEnd(7)}  ${String(P.maxBars).padStart(7)}  ` +
        `${String(s.n).padStart(6)}  ${(s.n ? (s.wins / s.n) * 100 : 0).toFixed(0).padStart(4)}%  ` +
        `${String(`${s.green}/${s.traded}`).padStart(9)}   ${d(s.grossUsd)}  ${d(-s.costUsd)}  ${d(s.usd)}`
    );
  }
  console.log(`\nprofitable combos: ${profits}/${rows.length}`);
  const best = rows[0];
  if (best) {
    console.log(
      `best: tf=${tf} dev=${best.P.devMult} sl=${best.P.slMult} adxMax=${best.P.adxMax} erMax=${best.P.erMax} ` +
        `session=${best.P.sessionStart}-${best.P.sessionEnd} maxBars=${best.P.maxBars} = $${best.s.usd.toFixed(2)} ` +
        `(${best.s.n} trades)`
    );
  }
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { days: 45, tf: '5m', tune: false, dev: null, sl: null, adx: null, er: null, session: null, maxBars: null, cooldown: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--tune') a.tune = true;
    else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--tf') a.tf = argv[++i];
    else if (k === '--dev') a.dev = Number(argv[++i]);
    else if (k === '--sl') a.sl = Number(argv[++i]);
    else if (k === '--adx') a.adx = Number(argv[++i]);
    else if (k === '--er') a.er = Number(argv[++i]);
    else if (k === '--maxbars') a.maxBars = Number(argv[++i]);
    else if (k === '--cooldown') a.cooldown = Number(argv[++i]);
    else if (k === '--session') {
      const [s, e] = argv[++i].split('-').map(Number);
      a.session = [s, e];
    }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  const data = prepare(a.tf);

  console.log(`// VWAP mean-reversion — ${SYMBOL} ${a.tf}`);
  console.log('costs: limit entry 2bps (maker) + limit target 2bps (maker); stop/time exits taker 5bps + 2bps slippage');

  if (a.tune) {
    tune(a.tf, a.days, data);
    return;
  }

  const P = { ...BASE, tf: a.tf };
  if (a.dev != null) P.devMult = a.dev;
  if (a.sl != null) P.slMult = a.sl;
  if (a.adx != null) P.adxMax = a.adx;
  if (a.er != null) P.erMax = a.er;
  if (a.maxBars != null) P.maxBars = a.maxBars;
  if (a.cooldown != null) P.cooldown = a.cooldown;
  if (a.session) { P.sessionStart = a.session[0]; P.sessionEnd = a.session[1]; }
  report(P, data, a.days);
}

main();
