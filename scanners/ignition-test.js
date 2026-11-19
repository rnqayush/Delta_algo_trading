// Does the "ignition bar" edge survive on the WHOLE universe, or was it just
// survivorship? This takes every liquid perpetual (not only the gainers), fires
// the breakout-expansion long, and measures forward R with realistic costs —
// against an unfiltered "buy every up-bar" baseline on the same symbols.
//
//   node scanners/ignition-test.js
//   node scanners/ignition-test.js --res 15m --days 14 --universe 100
//   node scanners/ignition-test.js --atrmult 2 --volmult 2 --targetr 2
//
// Options: --res --days --universe --minvol --atrmult --volmult --lookback
//          --targetr --maxbars --fee --slip --conc

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('../backtest/lib/data');
const { atr } = require('../src/utils/indicators');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';

const DEFAULTS = {
  res: '15m', days: 14, universe: 100, minvol: 1000000, conc: 4,
  atrMult: 1.5, volMult: 1.5, lookback: 20, targetR: 2, maxBars: 12,
  fee: 5, slip: 2, fixedStopAtr: 0,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith('--')) { args[k] = n; i += 1; } else { args[k] = true; }
  }
  return args;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadUniverse({ universe, minvol }) {
  const [pb, tb] = await Promise.all([fetchJson(`${BASE}/v2/products`), fetchJson(`${BASE}/v2/tickers`)]);
  const products = (Array.isArray(pb.result) ? pb.result : []).filter(
    (p) => p.contract_type === 'perpetual_futures' && p.state === 'live'
  );
  const byId = new Map(products.map((p) => [Number(p.id), p]));
  const rows = new Map();
  for (const t of Array.isArray(tb.result) ? tb.result : []) {
    if (t.contract_type !== 'perpetual_futures') continue;
    const p = byId.get(Number(t.product_id));
    if (!p) continue;
    rows.set(p.symbol, {
      symbol: p.symbol,
      turnoverUsd: Number(t.turnover_usd ?? t.turnover ?? 0),
      change24hPct: Number(t.mark_change_24h ?? 0),
    });
  }
  return [...rows.values()]
    .filter((r) => r.turnoverUsd >= minvol)
    .sort((a, b) => b.turnoverUsd - a.turnoverUsd)
    .slice(0, universe);
}

// Forward test of one long entry, in R multiples, net of costs.
function tradeFrom(candles, i, stop, targetR, maxBars, costFrac) {
  const entry = candles[i].close;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  const target = entry + targetR * risk;
  let grossR;
  for (let j = i + 1; j <= Math.min(candles.length - 1, i + maxBars); j += 1) {
    const b = candles[j];
    if (b.low <= stop) {
      const fill = b.open < stop ? b.open : stop;      // gap through the stop
      grossR = (fill - entry) / risk;
      const cost = (entry * costFrac) / risk;          // 2 legs
      return grossR - cost;
    }
    if (b.high >= target) {
      const fill = b.open > target ? b.open : target;   // gap through the target
      grossR = (fill - entry) / risk;
      const cost = (entry * costFrac) / risk;
      return grossR - cost;
    }
  }
  const b = candles[Math.min(candles.length - 1, i + maxBars)];
  grossR = (b.close - entry) / risk;
  const cost = (entry * costFrac) / risk;
  return grossR - cost;
}

function scan(candles, opts) {
  const { atrMult, volMult, lookback, targetR, maxBars, costFrac, fixedStopAtr } = opts;
  const n = candles.length;
  const a = atr(candles, 14);
  const volAvg = new Array(n).fill(null);
  let vs = 0;
  for (let i = 0; i < n; i += 1) {
    volAvg[i] = i >= 20 ? vs / 20 : null;
    vs += candles[i].volume;
    if (i >= 20) vs -= candles[i - 20].volume;
  }

  const filtered = [];
  const allUp = [];
  for (let i = Math.max(21, lookback + 1); i < n - 1; i += 1) {
    const c = candles[i];
    const range = c.high - c.low;
    if (!(range > 0) || !(a[i] > 0) || !(volAvg[i] > 0)) continue;

    let priorHigh = -Infinity;
    for (let j = i - lookback; j < i; j += 1) if (candles[j].high > priorHigh) priorHigh = candles[j].high;

    const up = c.close > c.open;
    const rangeATR = range / a[i];
    const volRatio = c.volume / volAvg[i];
    const breaks = c.high > priorHigh;

    const stop = fixedStopAtr > 0 ? c.close - fixedStopAtr * a[i] : c.low;

    if (up) {
      const r = tradeFrom(candles, i, stop, targetR, maxBars, costFrac);
      if (r !== null) allUp.push({ r, time: c.time });
    }
    if (up && rangeATR >= atrMult && volRatio >= volMult && breaks) {
      const r = tradeFrom(candles, i, stop, targetR, maxBars, costFrac);
      if (r !== null) filtered.push({ r, time: c.time });
    }
  }
  return { filtered, allUp };
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const grossWin = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rs.filter((r) => r <= 0).reduce((s, r) => s + r, 0));
  return {
    n,
    winPct: (wins.length / n) * 100,
    expectancy: rs.reduce((s, r) => s + r, 0) / n,
    totR: rs.reduce((s, r) => s + r, 0),
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
  };
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));
const money = (v) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return '-';
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(0)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const res = args.res ? String(args.res) : DEFAULTS.res;
  if (!RESOLUTION_SECONDS[res]) { console.error(`bad --res ${res}`); process.exit(1); }

  const o = {
    res,
    days: Number(args.days) || DEFAULTS.days,
    universe: Number(args.universe) || DEFAULTS.universe,
    minvol: args.minvol !== undefined ? Number(args.minvol) : DEFAULTS.minvol,
    conc: Number(args.conc) || DEFAULTS.conc,
    atrMult: Number(args.atrmult) || DEFAULTS.atrMult,
    volMult: Number(args.volmult) || DEFAULTS.volMult,
    lookback: Number(args.lookback) || DEFAULTS.lookback,
    targetR: Number(args.targetr) || DEFAULTS.targetR,
    maxBars: Number(args.maxbars) || DEFAULTS.maxBars,
    fixedStopAtr: Number(args.fixedstopatr) || DEFAULTS.fixedStopAtr,
    fee: Number(args.fee) || DEFAULTS.fee,
    slip: Number(args.slip) || DEFAULTS.slip,
  };
  o.costFrac = (o.fee + o.slip) / 1e4;

  const barSec = RESOLUTION_SECONDS[res];
  const fetchBars = Math.max(60, Math.floor((o.days * 86400) / barSec));

  console.log(`\nIgnition-bar test — ${res}, ${o.days}d, universe ${o.universe} liquid perps (>= $${o.minvol.toLocaleString()})`);
  console.log(`rule: up-bar, range >= ${o.atrMult}x ATR14, vol >= ${o.volMult}x avg20, high > prior ${o.lookback}-bar high`);
  console.log(`exit: stop = signal-bar low, target = ${o.targetR}R, time-stop ${o.maxBars} bars, costs ${o.fee}+${o.slip} bps/leg`);
  console.log('='.repeat(120));

  const list = await loadUniverse(o);
  if (!list.length) { console.error('no symbols'); process.exit(1); }
  console.log(`Downloading ${list.length} symbols...`);

  const perSymbol = await mapWithConcurrency(list, o.conc, async (entry) => {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - fetchBars * barSec;
    try {
      const { candles } = await downloadCandles({ symbol: entry.symbol, resolution: res, fromSec, toSec });
      if (candles.length < 100) return null;
      return { ...entry, ...scan(candles, o) };
    } catch { return null; }
  });

  const ok = perSymbol.filter(Boolean);
  const filtered = ok.flatMap((s) => s.filtered);
  const baseline = ok.flatMap((s) => s.allUp);
  const fs = stats(filtered);
  const bs = stats(baseline);

  console.log(`\nSymbols tested: ${ok.length}   (of ${list.length} downloaded)\n`);
  console.log(`${pad('rule', 26)} | ${pad('signals', 8, true)} | ${pad('win%', 6, true)} | ${pad('exp R', 7, true)} | ${pad('total R', 9, true)} | ${pad('PF', 6, true)}`);
  console.log('-'.repeat(80));
  console.log(`${pad('ignition (filtered)', 26)} | ${pad(fs.n, 8, true)} | ${pad(fmt(fs.winPct, 1), 6, true)} | ${pad(fmt(fs.expectancy, 3), 7, true)} | ${pad(fmt(fs.totR, 1), 9, true)} | ${pad(fmt(fs.pf, 2), 6, true)}`);
  console.log(`${pad('buy every up-bar', 26)} | ${pad(bs.n, 8, true)} | ${pad(fmt(bs.winPct, 1), 6, true)} | ${pad(fmt(bs.expectancy, 3), 7, true)} | ${pad(fmt(bs.totR, 1), 9, true)} | ${pad(fmt(bs.pf, 2), 6, true)}`);
  console.log('-'.repeat(80));
  console.log(`${pad('lift', 26)} | ${pad('', 8, true)} | ${pad(fmt(fs.winPct - bs.winPct, 1), 6, true)} | ${pad(fmt(fs.expectancy - bs.expectancy, 3), 7, true)} | ${pad('', 9, true)} | ${pad(fmt(fs.pf - bs.pf, 2), 6, true)}`);

  // Split the ignition trades by whether the symbol was a 24h gainer or not.
  const gainerSigs = ok.filter((s) => s.change24hPct > 0).flatMap((s) => s.filtered);
  const otherSigs = ok.filter((s) => s.change24hPct <= 0).flatMap((s) => s.filtered);
  const gs = stats(gainerSigs);
  const os = stats(otherSigs);
  console.log(`\nSplit by the symbol's own 24h direction (same rule, different names):`);
  console.log(`  up-24h names    n=${pad(gs.n || 0, 5, true)}  win% ${pad(fmt(gs.winPct, 1), 5, true)}  exp R ${pad(fmt(gs.expectancy, 3), 7, true)}  PF ${fmt(gs.pf, 2)}`);
  console.log(`  down-24h names  n=${pad(os.n || 0, 5, true)}  win% ${pad(fmt(os.winPct, 1), 5, true)}  exp R ${pad(fmt(os.expectancy, 3), 7, true)}  PF ${fmt(os.pf, 2)}`);

  // Top symbols by total R from the rule.
  const bySym = ok.map((s) => ({ symbol: s.symbol, change: s.change24hPct, ...stats(s.filtered) }))
    .filter((s) => s.n >= 3)
    .sort((a, b) => b.totR - a.totR);
  console.log(`\nSymbols with >=3 signals, best/worst by total R:`);
  console.log(`  ${pad('symbol', 12)} | ${pad('24h%', 7, true)} | ${pad('n', 4, true)} | ${pad('win%', 6, true)} | ${pad('exp R', 7, true)} | ${pad('total R', 8, true)}`);
  for (const s of [...bySym.slice(0, 6), ...bySym.slice(-4)]) {
    console.log(`  ${pad(s.symbol, 12)} | ${pad(fmt(s.change, 1), 7, true)} | ${pad(s.n, 4, true)} | ${pad(fmt(s.winPct, 0), 6, true)} | ${pad(fmt(s.expectancy, 3), 7, true)} | ${pad(fmt(s.totR, 1), 8, true)}`);
  }

  console.log('\nNote: overlapping signals are counted independently (expectancy per signal, not a portfolio).');
  console.log('Costs = 2 legs x (fee+slip); a signal-bar-low stop is wide, so cost drag is modest, but so is the edge.\n');
}

main().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
