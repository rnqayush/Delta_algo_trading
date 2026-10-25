// HIGH-VOLUME CANDLE BREAKOUT — multi-symbol study
//
// The idea (from the user):
//   Watch many symbols at once. When a candle prints ABNORMAL volume it becomes
//   a level. Arm the breakout: if price then takes out that candle's HIGH, go
//   LONG with the stop at that same candle's LOW. (And the mirror: break of the
//   LOW -> SHORT with the stop at the candle's HIGH.)
//
// This script measures, honestly and across the whole Delta alt universe on
// disk, whether that actually pays after real fees. It also runs the exact
// MIRROR (fade the level) for free, because S/R work on this project showed
// fades often beat breakouts.
//
// Mechanics modelled (no look-ahead):
//   * signal bar   = bar i with volume >= volMult x SMA(volume, volPeriod)
//   * arming window= the level stays valid for `validity` bars after bar i
//   * trigger      = first bar that trades through the level (stop order, taker)
//   * stop         = the signal candle's opposite extreme
//   * target       = targetR x risk (resting limit, maker fill)
//   * time exit    = after `hold` bars at the close
//
// Cost schedule (Delta India retail perp, real numbers):
//   maker 2 bps | taker 5 bps | slippage 2 bps
//   -> round trip 9 bps if the target fills, 14 bps if the stop is hit.
//
// R and bps metrics are invariant to contract size, so a flat contract_value is
// fine for ranking; absolute $ is indicative.
//
//   node backtest/research-hvbreakout.js --tf 5m --days 21
//   node backtest/research-hvbreakout.js --tf 5m --volMult 3 --targetR 2
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./lib/data');

const EXEC_DIR = path.join(DATA_DIR, 'research', 'exec');

const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

const CFG = {
  contractValue: 0.001,
  initialEquity: 1200,
  riskPct: 0.005,
  maxNotionalPct: 20,
};

const ARGS = {
  tf: '5m',
  days: 0,
  volMult: 2.0,
  volPeriod: 20,
  atrPeriod: 14,
  validity: 12, // bars the level stays armed after the HV candle
  targetR: 5.0,
  hold: 60, // max bars in a trade
  minTrades: 30,
  minSymbols: 6,
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

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

// ---------------------------------------------------------------------------
// data loading (cache lives in two places on this project)
// ---------------------------------------------------------------------------

function readCache(symbol, tf, dir) {
  const file = path.join(dir, `${symbol}_${tf}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.candles) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function loadCandles(symbol, tf) {
  return readCache(symbol, tf, DATA_DIR) || readCache(symbol, tf, EXEC_DIR);
}

function discover(tf) {
  const names = new Set();
  for (const dir of [DATA_DIR, EXEC_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(new RegExp(`^(.+)_${tf}\\.json$`));
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// sizing + cost
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (dist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

// Simulate one trade from the trigger bar onward. Returns a trade record.
function simulate(candles, triggerBar, dir, entry, stop, target, kind) {
  const contracts = sizeContracts(entry, stop);
  if (!(contracts > 0)) return null;
  const riskDist = Math.abs(entry - stop);
  if (!(riskDist > 0)) return null;

  const end = Math.min(candles.length - 1, triggerBar + ARGS.hold);
  let exitPrice = candles[end].close;
  let exitKind = 'time';
  for (let m = triggerBar; m <= end; m += 1) {
    const hitStop = dir === 1 ? candles[m].low <= stop : candles[m].high >= stop;
    const hitTarget = dir === 1 ? candles[m].high >= target : candles[m].low <= target;
    if (hitStop) { exitPrice = stop; exitKind = 'stop'; break; }
    if (hitTarget) { exitPrice = target; exitKind = 'target'; break; }
  }

  const cv = CFG.contractValue;
  const entryNotional = entry * contracts * cv;
  const exitNotional = exitPrice * contracts * cv;
  const feeEntry = entryNotional * (REAL.taker + REAL.slip);
  const exitRate = exitKind === 'target' ? REAL.maker : REAL.taker + REAL.slip;
  const feeExit = exitNotional * exitRate;
  const gross = (exitPrice - entry) * dir * contracts * cv;
  const net = gross - feeEntry - feeExit;
  const risk = riskDist * contracts * cv;

  return {
    kind,
    dir,
    exitKind,
    gross,
    net,
    risk,
    r: gross / risk,
    netR: net / risk,
    grossBps: (gross / entryNotional) * 1e4,
    costBps: ((feeEntry + feeExit) / entryNotional) * 1e4,
    netBps: (net / entryNotional) * 1e4,
  };
}

// ---------------------------------------------------------------------------
// signal -> candidate trades
// ---------------------------------------------------------------------------

// For an HV candle at index i, find the first breakout (either side) inside the
// arming window and emit the breakout + the mirrored fade from that trigger.
function tradesFor(candles, i, volAvg, atrArr) {
  const bar = candles[i];
  if (!volAvg[i] || bar.volume < ARGS.volMult * volAvg[i]) return [];
  const range = bar.high - bar.low;
  if (!(range > 0)) return [];

  const up = bar.high, dn = bar.low;

  // find the earliest trigger of either side
  let trig = -1, side = 0;
  const last = Math.min(candles.length - 2, i + ARGS.validity);
  for (let m = i + 1; m <= last; m += 1) {
    const hitUp = candles[m].high >= up;
    const hitDn = candles[m].low <= dn;
    if (hitUp && hitDn) {
      // both broken in the same bar — pick the side closer to the open
      const dUp = Math.abs(candles[m].open - up);
      const dDn = Math.abs(candles[m].open - dn);
      trig = m; side = dUp <= dDn ? 1 : -1;
      break;
    }
    if (hitUp) { trig = m; side = 1; break; }
    if (hitDn) { trig = m; side = -1; break; }
  }
  if (trig < 0) return [];

  const open = candles[trig].open;
  const out = [];
  const rangeAtr = atrArr[i] ? range / atrArr[i] : null;

  if (side === 1) {
    // breakout through the HIGH -> long, stop = candle low
    const entry = Math.max(up, open);
    const stop = dn;
    const risk = entry - stop;
    if (risk > 0) {
      out.push(simulate(candles, trig, 1, entry, stop, entry + ARGS.targetR * risk, 'breakoutLong'));
      // mirror fade: short the same level, stop mirror, target mirror
      out.push(simulate(candles, trig, -1, entry, entry + risk, entry - ARGS.targetR * risk, 'fadeShort'));
    }
  } else {
    // breakout through the LOW -> short, stop = candle high
    const entry = Math.min(dn, open);
    const stop = up;
    const risk = stop - entry;
    if (risk > 0) {
      out.push(simulate(candles, trig, -1, entry, stop, entry - ARGS.targetR * risk, 'breakoutShort'));
      out.push(simulate(candles, trig, 1, entry, entry - risk, entry + ARGS.targetR * risk, 'fadeLong'));
    }
  }

  for (const t of out) {
    if (t) { t.rangeAtr = rangeAtr; t.half = i + 1 < candles.length / 2 ? 0 : 1; t.time = candles[trig].time; }
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

function agg(trades) {
  const n = trades.length;
  if (!n) return null;
  const mean = (f) => trades.reduce((s, t) => s + f(t), 0) / n;
  const gp = trades.filter((t) => t.gross > 0).reduce((s, t) => s + t.gross, 0);
  const gl = Math.abs(trades.filter((t) => t.gross <= 0).reduce((s, t) => s + t.gross, 0));
  const np = trades.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const nl = Math.abs(trades.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const win = trades.filter((t) => t.net > 0).length / n;
  return {
    n,
    win,
    grossPF: gl > 0 ? gp / gl : Infinity,
    netPF: nl > 0 ? np / nl : Infinity,
    grossR: mean((t) => t.r),
    netR: mean((t) => t.netR),
    grossBps: mean((t) => t.grossBps),
    costBps: mean((t) => t.costBps),
    netBps: mean((t) => t.netBps),
    dollars: trades.reduce((s, t) => s + t.net, 0),
  };
}

const KINDS = [
  { key: 'breakoutLong', label: 'BREAKOUT long' },
  { key: 'breakoutShort', label: 'BREAKOUT short' },
  { key: 'fadeShort', label: 'fade short' },
  { key: 'fadeLong', label: 'fade long' },
];

function pad(t, w, right = false) {
  const s = String(t);
  return right ? s.padStart(w) : s.padEnd(w);
}
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'inf');

function printGroup(label, a) {
  if (!a) return;
  console.log(
    `  ${pad(label, 16)} | ${pad(a.n, 6, true)} | ${pad((a.win * 100).toFixed(1), 5, true)} | ${pad(f(a.grossPF), 6, true)} | ` +
      `${pad(f(a.netPF), 6, true)} | ${pad(f(a.grossR, 3), 7, true)} | ${pad(f(a.netR, 3), 7, true)} | ` +
      `${pad(a.grossBps.toFixed(2), 9, true)} | ${pad(a.costBps.toFixed(2), 8, true)} | ${pad(a.netBps.toFixed(2), 9, true)} | ${pad(Math.round(a.dollars), 8, true)}`
  );
}

function main() {
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === '--tf') ARGS.tf = process.argv[++i];
    else if (a === '--days') ARGS.days = Number(process.argv[++i]);
    else if (a === '--volMult') ARGS.volMult = Number(process.argv[++i]);
    else if (a === '--volPeriod') ARGS.volPeriod = Number(process.argv[++i]);
    else if (a === '--validity') ARGS.validity = Number(process.argv[++i]);
    else if (a === '--targetR') ARGS.targetR = Number(process.argv[++i]);
    else if (a === '--hold') ARGS.hold = Number(process.argv[++i]);
    else if (a === '--minTrades') ARGS.minTrades = Number(process.argv[++i]);
  }

  const symbols = discover(ARGS.tf);
  if (!symbols.length) throw new Error(`No *_${ARGS.tf}.json caches found.`);

  console.log('============================================================');
  console.log(` HIGH-VOLUME CANDLE BREAKOUT — ${ARGS.tf} | ${symbols.length} symbols | last ${ARGS.days || 'all'}d`);
  console.log(` HV = volume >= ${ARGS.volMult}x SMA(${ARGS.volPeriod}) | validity ${ARGS.validity} bars | stop = candle extreme | target ${ARGS.targetR}R | hold ${ARGS.hold}`);
  console.log(` cost: maker ${(REAL.maker * 1e4).toFixed(0)}bps  taker ${(REAL.taker * 1e4).toFixed(0)}bps  slip ${(REAL.slip * 1e4).toFixed(0)}bps`);
  console.log('============================================================');

  const all = { breakoutLong: [], breakoutShort: [], fadeShort: [], fadeLong: [], breakout: [], fade: [] };
  const perSymbol = [];
  const byRange = { narrow: [], wide: [] };
  const hvTimes = [];

  for (const symbol of symbols) {
    const cached = loadCandles(symbol, ARGS.tf);
    const minBars = ARGS.days > 0 ? 120 : 800;
    if (!cached || !cached.candles || cached.candles.length < minBars) continue;
    const candles = cached.candles;
    // indicators always use the FULL history; --days only limits which signals
    // are counted, so short windows don't starve the ATR/volume averages.
    const cutoff = ARGS.days > 0 ? candles[candles.length - 1].time - ARGS.days * 86400 : 0;

    const atrArr = atr(candles, ARGS.atrPeriod);
    const volAvg = sma(candles.map((c) => c.volume), ARGS.volPeriod);

    const mine = [];
    for (let i = ARGS.volPeriod + ARGS.atrPeriod; i < candles.length - 2; i += 1) {
      if (!atrArr[i]) continue;
      if (cutoff && candles[i].time < cutoff) continue;
      if (volAvg[i] && candles[i].volume >= ARGS.volMult * volAvg[i]) hvTimes.push({ symbol, time: candles[i].time });
      const ts = tradesFor(candles, i, volAvg, atrArr);
      for (const t of ts) {
        t.symbol = symbol;
        all[t.kind].push(t);
        if (t.kind === 'breakoutLong' || t.kind === 'breakoutShort') {
          all.breakout.push(t);
          if (t.rangeAtr !== null) (t.rangeAtr <= 1.5 ? byRange.narrow : byRange.wide).push(t);
        } else {
          all.fade.push(t);
        }
        mine.push(t);
      }
    }
    const med = (arr) => (arr.length ? arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0);
    const medDollarVol = med(candles.map((c) => c.close * c.volume));
    const boMine = mine.filter((t) => t.kind.startsWith('breakout'));
    const boAgg = agg(boMine);
    perSymbol.push({
      symbol,
      hvTrades: mine.length,
      breakouts: boMine.length,
      boWin: boAgg ? boAgg.win : 0,
      boNetR: boAgg ? boAgg.netR : 0,
      boDollars: boAgg ? boAgg.dollars : 0,
      medDollarVol,
    });
  }

  console.log('\nBY KIND (pooled across all symbols)');
  console.log(
    `  ${pad('kind', 16)} | ${pad('n', 6, true)} | ${pad('win%', 5, true)} | ${pad('gPF', 6, true)} | ${pad('nPF', 6, true)} | ${pad('grossR', 7, true)} | ${pad('netR', 7, true)} | ${pad('grossBps', 9, true)} | ${pad('costBps', 8, true)} | ${pad('netBps', 9, true)} | ${pad('net$', 8, true)}`
  );
  console.log('  ' + '-'.repeat(122));
  printGroup('breakout (all)', agg(all.breakout));
  for (const k of KINDS) printGroup(k.label, agg(all[k.key]));
  printGroup('fade (all)', agg(all.fade));

  console.log('\nBREAKOUT SPLIT BY HV-CANDLE RANGE (narrow = tight stop, better R:R)');
  console.log(
    `  ${pad('subset', 16)} | ${pad('n', 6, true)} | ${pad('win%', 5, true)} | ${pad('gPF', 6, true)} | ${pad('nPF', 6, true)} | ${pad('grossR', 7, true)} | ${pad('netR', 7, true)} | ${pad('grossBps', 9, true)} | ${pad('costBps', 8, true)} | ${pad('netBps', 9, true)} | ${pad('net$', 8, true)}`
  );
  console.log('  ' + '-'.repeat(122));
  printGroup('narrow <=1.5ATR', agg(byRange.narrow));
  printGroup('wide  >1.5ATR', agg(byRange.wide));

  console.log('\nOUT-OF-SAMPLE (per symbol: first half vs second half)');
  console.log(
    `  ${pad('subset', 16)} | ${pad('n', 6, true)} | ${pad('win%', 5, true)} | ${pad('gPF', 6, true)} | ${pad('nPF', 6, true)} | ${pad('grossR', 7, true)} | ${pad('netR', 7, true)} | ${pad('grossBps', 9, true)} | ${pad('costBps', 8, true)} | ${pad('netBps', 9, true)} | ${pad('net$', 8, true)}`
  );
  console.log('  ' + '-'.repeat(122));
  printGroup('breakout H1', agg(all.breakout.filter((t) => t.half === 0)));
  printGroup('breakout H2', agg(all.breakout.filter((t) => t.half === 1)));

  // ---- signals + P&L per day (watching ALL symbols simultaneously) --------
  if (ARGS.days > 0) {
    const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
    const m = new Map();
    for (const t of all.breakout) {
      const d = dayKey(t.time);
      let e = m.get(d);
      if (!e) { e = { sig: 0, long: 0, short: 0, net: 0, wins: 0, syms: new Set() }; m.set(d, e); }
      e.sig += 1;
      if (t.dir === 1) e.long += 1; else e.short += 1;
      e.net += t.net;
      if (t.net > 0) e.wins += 1;
      e.syms.add(t.symbol);
    }
    const hvByDay = new Map();
    for (const h of hvTimes) {
      const d = dayKey(h.time);
      hvByDay.set(d, (hvByDay.get(d) || 0) + 1);
    }
    const days = [...m.keys()].sort();
    console.log('\n4H BREAKOUT — PER-DAY SIGNALS + P&L  (all symbols watched simultaneously)');
    console.log(
      `  ${pad('date (UTC)', 12)} | ${pad('HV', 5, true)} | ${pad('signals', 8, true)} | ${pad('long', 5, true)} | ${pad('short', 5, true)} | ${pad('sym', 4, true)} | ${pad('win%', 5, true)} | ${pad('net$', 9, true)} | ${pad('cum$', 10, true)}`
    );
    console.log('  ' + '-'.repeat(92));
    let tSig = 0, tNet = 0, cum = 0, green = 0, red = 0;
    for (const d of days) {
      const e = m.get(d);
      tSig += e.sig; tNet += e.net;
      cum += e.net;
      if (e.net > 0) green += 1; else if (e.net < 0) red += 1;
      const wr = e.sig ? (e.wins / e.sig) * 100 : 0;
      console.log(
        `  ${pad(d, 12)} | ${pad(hvByDay.get(d) || 0, 5, true)} | ${pad(e.sig, 8, true)} | ${pad(e.long, 5, true)} | ${pad(e.short, 5, true)} | ${pad(e.syms.size, 4, true)} | ${pad(wr.toFixed(1), 5, true)} | ${pad(Math.round(e.net), 9, true)} | ${pad(Math.round(cum), 10, true)}`
      );
    }
    console.log('  ' + '-'.repeat(92));
    console.log(`  TOTAL over ${days.length} days: ${tSig} signals (${(tSig / days.length).toFixed(1)}/day), net $${Math.round(tNet)} (${green} green / ${red} red days)`);
    console.log(`  END-OF-PERIOD EQUITY CHANGE: ${tNet >= 0 ? '+' : ''}$${Math.round(tNet)} on $${CFG.initialEquity} base (${((tNet / CFG.initialEquity) * 100).toFixed(2)}%)`);
  }

  // ---- out-of-sample: rank symbols on 1st half, verify on 2nd half ---------
  const posFirst = perSymbol.filter((p) => p.boNetR > 0 && p.breakouts >= 5).map((p) => p.symbol);
  console.log('\nPER-SYMBOL BREAKOUT (sorted by median $ volume; small caps = low $ vol)');
  console.log(`  ${pad('symbol', 14)} | ${pad('HV', 5, true)} | ${pad('breakouts', 9, true)} | ${pad('win%', 5, true)} | ${pad('netR', 7, true)} | ${pad('net$', 8, true)} | ${pad('med$vol', 12, true)}`);
  console.log('  ' + '-'.repeat(74));
  const ranked = perSymbol.slice().sort((a, b) => a.medDollarVol - b.medDollarVol);
  for (const p of ranked) {
    console.log(
      `  ${pad(p.symbol, 14)} | ${pad(p.hvTrades, 5, true)} | ${pad(p.breakouts, 9, true)} | ${pad((p.boWin * 100).toFixed(1), 5, true)} | ` +
        `${pad(f(p.boNetR, 3), 7, true)} | ${pad(Math.round(p.boDollars), 8, true)} | ${pad(p.medDollarVol.toFixed(0), 12, true)}`
    );
  }

  const bo = agg(all.breakout);
  console.log('\nVERDICT');
  if (bo) {
    const clears = bo.netBps > 0 && bo.n >= ARGS.minTrades;
    console.log(`  breakout trades: n=${bo.n}  win=${(bo.win * 100).toFixed(1)}%  gross=${bo.grossBps.toFixed(2)}bps  cost=${bo.costBps.toFixed(2)}bps  net=${bo.netBps.toFixed(2)}bps`);
    console.log(`  => ${clears ? 'POSITIVE after fees' : 'NEGATIVE after fees'} (net PF ${f(bo.netPF)})`);
  }
  console.log(`  symbols with positive breakout netR (>=5 trades): ${posFirst.length}/${perSymbol.length}`);
  console.log(`  best symbol: ${ranked.slice().sort((a, b) => b.boNetR - a.boNetR)[0]?.symbol || '-'}`);
}

main();
