// Anatomy of a "big move": takes the top N 24h GAINERS on Delta, downloads
// their candles, finds the big expansion candles, and reports what they have in
// common — with an "ordinary up candle" baseline so the difference is visible.
//
//   node scanners/big-mover-scanner.js                       # 1h bars, 30d, top 10 gainers
//   node scanners/big-mover-scanner.js --res 15m --days 14   # finer, shorter window
//   node scanners/big-mover-scanner.js --top 20 --minvol 0
//
// Options:
//   --res      candle resolution (default 1h)
//   --days     look-back window in days (default 30)
//   --top      number of top gainers to analyse (default 10)
//   --universe how many top-turnover symbols to consider (default 150)
//   --minvol   minimum 24h turnover USD, 0 disables (default 1000000)
//   --bigatr   a big candle is one whose range >= this x ATR14 (default 2.0)
//   --conc     parallel downloads (default 4)

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('../backtest/lib/data');
const { atr } = require('../src/utils/indicators');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';

const DEFAULTS = {
  res: '1h', days: 30, top: 10, universe: 150,
  minvol: 1000000, bigatr: 2.0, conc: 4,
};

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
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// Top gainers by 24h change, richest first, with a turnover floor.
async function loadGainers({ universe, minvol, top }) {
  const [productsBody, tickersBody] = await Promise.all([
    fetchJson(`${BASE}/v2/products`),
    fetchJson(`${BASE}/v2/tickers`),
  ]);

  const products = (Array.isArray(productsBody.result) ? productsBody.result : []).filter(
    (p) => p.contract_type === 'perpetual_futures' && p.state === 'live'
  );
  const productById = new Map(products.map((p) => [Number(p.id), p]));

  const rows = new Map();
  for (const ticker of Array.isArray(tickersBody.result) ? tickersBody.result : []) {
    if (ticker.contract_type !== 'perpetual_futures') continue;
    const product = productById.get(Number(ticker.product_id));
    if (!product) continue;
    rows.set(product.symbol, {
      symbol: product.symbol,
      turnoverUsd: Number(ticker.turnover_usd ?? ticker.turnover ?? 0),
      price: Number(ticker.mark_price ?? ticker.close ?? 0),
      change24hPct: Number(ticker.mark_change_24h ?? ticker.ltp_change_24h ?? 0),
    });
  }

  const eligible = [...rows.values()].filter((r) => r.turnoverUsd >= minvol && r.price > 0);
  eligible.sort((a, b) => b.change24hPct - a.change24hPct);
  return { list: eligible.slice(0, top), eligibleCount: eligible.length, universeCount: rows.size };
}

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (values) => {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const pct = (arr, pred) => (arr.length ? (arr.filter(pred).length / arr.length) * 100 : null);

// Per-bar feature vector used to describe both big and ordinary candles.
function featuresAt(candles, i, atrSeries, volAvg) {
  const c = candles[i];
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  const a = atrSeries[i];
  const vAvg = volAvg[i];
  const up = c.close > c.open;

  const w = 20;
  const from = Math.max(0, i - w);
  let priorHigh20 = -Infinity;
  let priorLow20 = Infinity;
  for (let j = from; j < i; j += 1) {
    if (candles[j].high > priorHigh20) priorHigh20 = candles[j].high;
    if (candles[j].low < priorLow20) priorLow20 = candles[j].low;
  }

  let priorHigh5 = -Infinity;
  let priorLow5 = Infinity;
  for (let j = Math.max(0, i - 5); j < i; j += 1) {
    if (candles[j].high > priorHigh5) priorHigh5 = candles[j].high;
    if (candles[j].low < priorLow5) priorLow5 = candles[j].low;
  }

  const priorRange20 = priorHigh20 - priorLow20;
  const priorRange5 = priorHigh5 - priorLow5;

  const p = candles[i - 1];
  const prevRange = p.high - p.low;

  return {
    time: c.time,
    up,
    rangePct: (range / c.close) * 100,
    rangeATR: a > 0 ? range / a : null,
    volRatio: vAvg > 0 ? c.volume / vAvg : null,
    bodyPct: (Math.abs(c.close - c.open) / range) * 100,
    clv: (c.close - c.low) / range,                 // 1 = close at high
    upperWickPct: (c.high - Math.max(c.open, c.close)) / range * 100,
    brokeHigh20: c.high > priorHigh20,
    closedAboveHigh20: c.close > priorHigh20,
    squeeze5v20: priorRange20 > 0 ? priorRange5 / priorRange20 : null, // <1 = contraction
    priorRange20Pct: (priorRange20 / c.close) * 100,
    // where in the prior 20-bar range did this bar open (1 = at the top)
    openPosInRange20: priorRange20 > 0 ? (c.open - priorLow20) / priorRange20 : 0.5,
    prevRangeATR: atrSeries[i - 1] > 0 ? prevRange / atrSeries[i - 1] : null,
    prevUp: p.close > p.open,
    prevVolRatio: volAvg[i - 1] > 0 ? p.volume / volAvg[i - 1] : null,
  };
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const utc = (sec) => new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const res = args.res ? String(args.res) : DEFAULTS.res;
  if (!RESOLUTION_SECONDS[res]) {
    console.error(`Unsupported --res "${res}". Use: ${Object.keys(RESOLUTION_SECONDS).join(' ')}`);
    process.exit(1);
  }
  const days = Number(args.days) || DEFAULTS.days;
  const top = Number(args.top) || DEFAULTS.top;
  const universe = Number(args.universe) || DEFAULTS.universe;
  const minvol = args.minvol !== undefined ? Number(args.minvol) : DEFAULTS.minvol;
  const bigATR = args.bigatr !== undefined ? Number(args.bigatr) : DEFAULTS.bigatr;
  const conc = Number(args.conc) || DEFAULTS.conc;

  const barSec = RESOLUTION_SECONDS[res];
  const fetchBars = Math.max(60, Math.floor((days * 86400) / barSec));

  console.log(`\nBig-move anatomy — ${res} bars, last ${days}d, top ${top} 24h gainers (>= $${minvol.toLocaleString()} turnover)`);
  console.log('='.repeat(140));

  const { list, eligibleCount, universeCount } = await loadGainers({ universe, minvol, top });
  if (!list.length) { console.error('No eligible gainers.'); process.exit(1); }
  console.log(`Universe: ${universeCount} perpetuals, ${eligibleCount} above the turnover floor. Downloading ${list.length}...\n`);

  const analyzed = await mapWithConcurrency(list, conc, async (entry) => {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - fetchBars * barSec;
    try {
      const { candles } = await downloadCandles({ symbol: entry.symbol, resolution: res, fromSec, toSec });
      if (candles.length < 60) return { ...entry, skipped: `${candles.length} bars` };
      return { ...entry, candles };
    } catch (error) {
      return { ...entry, skipped: error.message };
    }
  });

  const results = [];
  const allBig = [];
  const allUp = [];

  for (const row of analyzed) {
    if (row.skipped) { results.push(row); continue; }
    const candles = row.candles;
    const atrSeries = atr(candles, 14);
    const volAvg = new Array(candles.length).fill(null);
    let vsum = 0;
    for (let i = 0; i < candles.length; i += 1) {
      volAvg[i] = i >= 20 ? vsum / 20 : null;
      vsum += candles[i].volume;
      if (i >= 20) vsum -= candles[i - 20].volume;
    }

    const big = [];
    const ups = [];
    for (let i = 21; i < candles.length - 3; i += 1) {
      const f = featuresAt(candles, i, atrSeries, volAvg);
      if (!f || !Number.isFinite(f.rangeATR)) continue;
      if (f.up) ups.push(f);
      if (f.up && f.rangeATR >= bigATR) {
        // forward outcome: best/worst excursion over the next 3 bars, from this close
        const c0 = candles[i].close;
        let mfe = -Infinity;
        let mae = Infinity;
        for (let j = i + 1; j <= Math.min(candles.length - 1, i + 3); j += 1) {
          mfe = Math.max(mfe, ((candles[j].high - c0) / c0) * 100);
          mae = Math.min(mae, ((candles[j].low - c0) / c0) * 100);
        }
        big.push({ ...f, symbol: row.symbol, mfe, mae });
      }
    }

    const winHigh = Math.max(...candles.map((c) => c.high));
    const winLow = Math.min(...candles.map((c) => c.low));
    const netPct = ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100;

    allBig.push(...big);
    allUp.push(...ups);
    results.push({ ...row, big, netPct, winLow, winHigh });
  }

  // ---- per-gainer table ---------------------------------------------------
  console.log(`${pad('#', 3, true)} | ${pad('symbol', 12)} | ${pad('24h%', 8, true)} | ${pad('24h vol', 9, true)} | ` +
    `${pad('price', 12, true)} | ${pad('net%', 8, true)} | ${pad('bigs', 5, true)} | ${pad('bigest%', 8, true)}`);
  console.log('-'.repeat(100));
  results.forEach((r, idx) => {
    if (r.skipped) { console.log(`${pad(idx + 1, 3, true)} | ${pad(r.symbol, 12)} | skipped: ${r.skipped}`); return; }
    const biggest = r.big.reduce((m, b) => Math.max(m, b.rangeATR), 0);
    console.log(
      `${pad(idx + 1, 3, true)} | ${pad(r.symbol, 12)} | ${pad((r.change24hPct >= 0 ? '+' : '') + fmt(r.change24hPct, 2), 8, true)} | ` +
      `${pad(money(r.turnoverUsd), 9, true)} | ${pad(r.price, 12, true)} | ` +
      `${pad((r.netPct >= 0 ? '+' : '') + fmt(r.netPct, 1), 8, true)} | ${pad(r.big.length, 5, true)} | ` +
      `${pad(fmt(biggest, 2) + 'x', 8, true)}`
    );
  });

  // ---- biggest candles per gainer ----------------------------------------
  console.log(`\nBiggest up-candles formed (range >= ${bigATR}x ATR14), per gainer:`);
  for (const r of results) {
    if (r.skipped || !r.big.length) continue;
    const topBig = [...r.big].sort((a, b) => b.rangeATR - a.rangeATR).slice(0, 4);
    console.log(`\n  ${r.symbol}  (window net ${r.netPct >= 0 ? '+' : ''}${fmt(r.netPct, 1)}%)`);
    console.log(`    ${pad('when(UTC)', 13)} | ${pad('rng/ATR', 7, true)} | ${pad('rng%', 6, true)} | ${pad('vol x', 6, true)} | ` +
      `${pad('body%', 6, true)} | ${pad('close@', 7, true)} | ${pad('brk20', 5, true)} | ${pad('squeeze', 7, true)} | ${pad('next3 MFE/MAE', 14, true)}`);
    for (const b of topBig) {
      console.log(`    ${pad(utc(b.time), 13)} | ${pad(fmt(b.rangeATR, 2), 7, true)} | ${pad(fmt(b.rangePct, 2), 6, true)} | ` +
        `${pad(b.volRatio !== null ? fmt(b.volRatio, 1) : '-', 6, true)} | ${pad(fmt(b.bodyPct, 0), 6, true)} | ` +
        `${pad(fmt(b.clv * 100, 0) + '%', 7, true)} | ${pad(b.brokeHigh20 ? 'YES' : '-', 5, true)} | ` +
        `${pad(b.squeeze5v20 !== null ? fmt(b.squeeze5v20, 2) : '-', 7, true)} | ` +
        `${pad(`+${fmt(b.mfe, 1)}/${fmt(b.mae, 1)}`, 14, true)}`);
    }
  }

  // ---- aggregate commonality ---------------------------------------------
  const S = (label, bigVals, upVals, digits = 2) => {
    const b = median(bigVals);
    const u = median(upVals);
    const ratio = u ? b / u : NaN;
    console.log(`  ${pad(label, 34)} big: ${pad(fmt(b, digits), 8, true)}   ordinary-up: ${pad(fmt(u, digits), 8, true)}   ratio ${fmt(ratio, 2)}x`);
  };
  const P = (label, bigPct, upPct) => {
    console.log(`  ${pad(label, 34)} big: ${pad(fmt(bigPct, 0) + '%', 8, true)}   ordinary-up: ${pad(fmt(upPct, 0) + '%', 8, true)}`);
  };

  console.log(`\n${'='.repeat(140)}\nCOMMONALITY — ${allBig.length} big up-candles vs ${allUp.length} ordinary up-candles across ${results.filter((r) => r.big).length} gainers\n`);
  S('median range / ATR14', allBig.map((b) => b.rangeATR), allUp.map((b) => b.rangeATR));
  S('median volume vs 20-bar avg', allBig.map((b) => b.volRatio), allUp.map((b) => b.volRatio));
  S('median body % of range', allBig.map((b) => b.bodyPct), allUp.map((b) => b.bodyPct));
  S('median close pos (0..100%)', allBig.map((b) => b.clv * 100), allUp.map((b) => b.clv * 100));
  S('median upper wick % of range', allBig.map((b) => b.upperWickPct), allUp.map((b) => b.upperWickPct));
  S('median prior 5/20 range (squeeze)', allBig.map((b) => b.squeeze5v20), allUp.map((b) => b.squeeze5v20));
  S('median open pos in prior range%', allBig.map((b) => b.openPosInRange20 * 100), allUp.map((b) => b.openPosInRange20 * 100));
  S('median PREVIOUS bar range/ATR', allBig.map((b) => b.prevRangeATR), allUp.map((b) => b.prevRangeATR));
  S('median PREVIOUS bar volume x', allBig.map((b) => b.prevVolRatio), allUp.map((b) => b.prevVolRatio));
  console.log('');
  P('breaks prior 20-bar HIGH', pct(allBig, (b) => b.brokeHigh20), pct(allUp, (b) => b.brokeHigh20));
  P('CLOSES above prior 20-bar high', pct(allBig, (b) => b.closedAboveHigh20), pct(allUp, (b) => b.closedAboveHigh20));
  P('volume > 2x avg', pct(allBig, (b) => b.volRatio > 2), pct(allUp, (b) => b.volRatio > 2));
  P('opens in top 30% of prior range', pct(allBig, (b) => b.openPosInRange20 > 0.7), pct(allUp, (b) => b.openPosInRange20 > 0.7));
  P('previous bar also >= 2x ATR', pct(allBig, (b) => b.prevRangeATR >= bigATR), pct(allUp, (b) => b.prevRangeATR >= bigATR));
  P('previous bar was up', pct(allBig, (b) => b.prevUp), pct(allUp, (b) => b.prevUp));
  P('prior 5-bar range < 20-bar', pct(allBig, (b) => b.squeeze5v20 < 1), pct(allUp, (b) => b.squeeze5v20 < 1));
  P('close in top 25% of its range', pct(allBig, (b) => b.clv > 0.75), pct(allUp, (b) => b.clv > 0.75));
  console.log('');

  // Continuation: entering at the big candle close.
  const mfe = mean(allBig.map((b) => b.mfe));
  const mae = mean(allBig.map((b) => b.mae));
  const mfeMed = median(allBig.map((b) => b.mfe));
  const maeMed = median(allBig.map((b) => b.mae));
  const goodNext = pct(allBig, (b) => b.mfe > Math.abs(b.mae));
  console.log(`CONTINUATION — buy at the big candle's close, hold 3 bars:`);
  console.log(`  median next-3-bar MFE +${fmt(mfeMed, 2)}%  /  MAE ${fmt(maeMed, 2)}%   (mean +${fmt(mfe, 2)}% / ${fmt(mae, 2)}%)`);
  console.log(`  ${fmt(goodNext, 0)}% of big candles see more upside than downside over the next 3 bars\n`);

  // Breakout vs non-breakout continuation split.
  const brk = allBig.filter((b) => b.brokeHigh20);
  const nonBrk = allBig.filter((b) => !b.brokeHigh20);
  console.log(`SPLIT by whether the big candle broke the prior 20-bar high:`);
  console.log(`  breakout   n=${pad(brk.length, 4, true)}  median MFE +${fmt(median(brk.map((b) => b.mfe)), 2)}%  MAE ${fmt(median(brk.map((b) => b.mae)), 2)}%  vol ${fmt(median(brk.map((b) => b.volRatio)), 2)}x`);
  console.log(`  non-break  n=${pad(nonBrk.length, 4, true)}  median MFE +${fmt(median(nonBrk.map((b) => b.mfe)), 2)}%  MAE ${fmt(median(nonBrk.map((b) => b.mae)), 2)}%  vol ${fmt(median(nonBrk.map((b) => b.volRatio)), 2)}x`);

  // Ignition (first big candle after quiet bars) vs follow-on (previous bar also big).
  const ign = allBig.filter((b) => !(b.prevRangeATR >= bigATR));
  const cont = allBig.filter((b) => b.prevRangeATR >= bigATR);
  console.log(`\nSPLIT ignition (first big candle after quiet bars) vs follow-on (preceded by another big candle):`);
  console.log(`  ignition   n=${pad(ign.length, 4, true)}  brk20 ${pad(fmt(pct(ign, (b) => b.brokeHigh20), 0) + '%', 5, true)}  vol ${pad(fmt(median(ign.map((b) => b.volRatio)), 2) + 'x', 6, true)}  ` +
    `prior 5/20 ${pad(fmt(median(ign.map((b) => b.squeeze5v20)), 2), 5, true)}  median MFE +${fmt(median(ign.map((b) => b.mfe)), 2)}%  MAE ${fmt(median(ign.map((b) => b.mae)), 2)}%`);
  console.log(`  follow-on  n=${pad(cont.length, 4, true)}  brk20 ${pad(fmt(pct(cont, (b) => b.brokeHigh20), 0) + '%', 5, true)}  vol ${pad(fmt(median(cont.map((b) => b.volRatio)), 2) + 'x', 6, true)}  ` +
    `prior 5/20 ${pad(fmt(median(cont.map((b) => b.squeeze5v20)), 2), 5, true)}  median MFE +${fmt(median(cont.map((b) => b.mfe)), 2)}%  MAE ${fmt(median(cont.map((b) => b.mae)), 2)}%`);
}

main().catch((error) => { console.error('SCAN FAILED:', error.message); process.exit(1); });
