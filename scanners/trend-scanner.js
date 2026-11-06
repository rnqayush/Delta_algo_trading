// Ranks every Delta perpetual by how TRENDING it is right now — the mirror of
// range-scanner.js, which ranks the calmest. A "trend", for this scanner, is a
// liquid instrument that has moved a long way in one direction and is doing it
// cleanly, which is what a breakout / momentum / trend-following approach needs
// and what a fade approach should avoid.
//
// Six measures are computed, then combined into one rank-based score (0..1,
// higher = more trending):
//
//   move24h%  |24h change|. The raw "how far did it go" reading, straight from
//             the ticker (mark_change_24h). The eyeball definition of trending.
//   drift%    |last close - first open| / mid over the window. The same idea as
//             move24h but measured on the candles the scanner downloads, so it
//             describes the configured window rather than the exchange's 24h.
//   ER        Kaufman efficiency ratio (net move / total travel). ~1 = a
//             straight line, ~0 = pure chop. This is what separates a trend
//             from a violent random walk: both move a lot, only one is clean.
//   ADX       Wilder ADX(14). High = a strong directional trend.
//   atr%      ATR(14) / price. The volatility reading: a flat market cannot
//             trend, so this is included, not penalised.
//   range%    (highest high - lowest low) / mid. How far the window actually
//             travelled, independent of net drift.
//
// ER/ADX alone cannot tell a strong trend from a slow grind, and move24h% alone
// cannot tell a clean trend from a one-bar spike — hence the blend. The score is
// the mean of the per-metric rank percentiles, so no metric's units dominate,
// and every raw number is printed so you can overrule the ranking.
//
// Liquidity comes first: instruments under `--minvol` of 24h turnover are
// dropped before any trend maths, because a $50K/day micro-cap can post a clean
// 40% move that no real order could ever get filled in.
//
// Data: tickers/products for the universe and 24h stats, and candles always
// downloaded fresh via backtest/lib/data.js (downloadCandles — public endpoint,
// no keys, and deliberately NOT the caching wrapper, which would overwrite the
// long backtest series in backtest/data with a few days of data).
//
//   node scanners/trend-scanner.js                          # what is trending RIGHT NOW (2d of 15m bars)
//   node scanners/trend-scanner.js --res 1h --days 3        # a longer, coarser trend read
//   node scanners/trend-scanner.js --res 5m --days 1        # the intraday trend
//   node scanners/trend-scanner.js --dir up                 # only up-trending (or --dir down)
//   node scanners/trend-scanner.js --top 10 --universe 120 --minvol 250000
//   node scanners/trend-scanner.js --minadx 20 --miner 0.3
//   node scanners/trend-scanner.js --symbols BTCUSD,ETHUSD,SOLUSD
//
// Options:
//   --res       candle resolution: 1m 3m 5m 15m 30m 1h 4h 1d   (default 15m)
//   --days      look-back window in days                       (default 2)
//   --top       rows to print                                  (default 10)
//   --universe  how many top-turnover symbols to download      (default 60)
//   --minvol    minimum 24h turnover in USD, 0 disables        (default 1000000)
//   --dir       up | down | any, filter by 24h direction       (default any)
//   --minadx    minimum ADX, 0 disables                        (default 0)
//   --miner     minimum efficiency ratio, 0 disables           (default 0)
//   --symbols   explicit comma-separated list (skips turnover ranking)
//   --conc      parallel downloads                             (default 4)
//
// The score is a RANK, so it always returns "the most trending" symbol even in a
// universe where nothing is trending — the most trending of 60 flat markets is
// still flat. --minadx/--miner are absolute gates: pass them and the symbol is
// trending, fail them and it is excluded, however good the rest of the universe
// looks. "Nothing passed the gates" is a real answer.

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('../backtest/lib/data');
const { atr, adx, efficiencyRatio } = require('../src/utils/indicators');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';

const DEFAULTS = {
  res: '15m',
  days: 2,
  top: 10,
  universe: 60,
  minvol: 1000000,
  dir: 'any',
  // Absolute gates. A rank only orders the universe; these decide whether an
  // instrument is a trend at all. 0 disables any one gate.
  minadx: 0,
  miner: 0,
  conc: 4,
  symbols: null,
};

// A window only counts if nearly all of its bars are present, otherwise a late
// listing masquerades as a trend (fewer bars => a shorter, tighter sample).
const MIN_BAR_COVERAGE = 0.9;

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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------

// Live Delta perpetuals, richest first: the turnover floor removes dead markets
// and the cap keeps a scan to a sane number of downloads. 24h stats come from
// the ticker (mark_change_24h is already in PERCENT, e.g. -0.28 = -0.28%).
async function loadUniverse({ universe, minvol, symbols }) {
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
      productId: Number(product.id),
      turnoverUsd: Number(ticker.turnover_usd ?? ticker.turnover ?? 0),
      price: Number(ticker.mark_price ?? ticker.close ?? 0),
      change24hPct: Number(ticker.mark_change_24h ?? ticker.ltp_change_24h ?? 0),
      oiChange6hUsd: Number(ticker.oi_change_usd_6h ?? 0),
    });
  }

  if (symbols && symbols.length) {
    const wanted = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    const missing = wanted.filter((s) => !rows.has(s));
    return { list: wanted.filter((s) => rows.has(s)).map((s) => rows.get(s)), missing, ranked: false };
  }

  const list = [...rows.values()]
    .filter((r) => r.turnoverUsd >= minvol && r.price > 0)
    .sort((a, b) => b.turnoverUsd - a.turnoverUsd)
    .slice(0, universe);

  return { list, missing: [], ranked: true, eligible: rows.size };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const lastNumber = (series) => {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(series[i])) return series[i];
  }
  return null;
};

function extremes(candles) {
  let high = -Infinity;
  let low = Infinity;
  for (const candle of candles) {
    if (candle.high > high) high = candle.high;
    if (candle.low < low) low = candle.low;
  }
  return { high, low };
}

function analyze(candles) {
  const n = candles.length;
  const price = Number(candles[n - 1].close);
  if (!(price > 0)) return null;

  const { high, low } = extremes(candles);
  if (!(high > low)) return null;
  const mid = (high + low) / 2;

  const first = Number(candles[0].close);
  const netMove = price - first;

  return {
    bars: n,
    price,
    mid,
    // Net directional move over the window, as a SIGNED % (what a trend rider earns).
    signedDriftPct: (netMove / mid) * 100,
    driftPct: (Math.abs(netMove) / mid) * 100,
    rangePct: ((high - low) / mid) * 100,
    atrPct: ((lastNumber(atr(candles, 14)) ?? 0) / price) * 100,
    // Net move / total travel across the whole window (~0 chop, ~1 straight line).
    er: lastNumber(efficiencyRatio(candles, n - 1)),
    adx: lastNumber(adx(candles, 14)),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Each metric becomes a percentile rank across the universe, oriented so 1 is
// always "more trending", and the score is their mean. Rank-based, so a metric
// measured in % and one measured in index points (ADX) count the same.
const METRICS = [
  { key: 'move24hAbs', label: '24h%', lowerIsBetter: false },
  { key: 'driftPct', label: 'drift%', lowerIsBetter: false },
  { key: 'er', label: 'ER', lowerIsBetter: false },
  { key: 'adx', label: 'ADX', lowerIsBetter: false },
  { key: 'atrPct', label: 'atr%', lowerIsBetter: false },
  { key: 'rangePct', label: 'range%', lowerIsBetter: false },
];

function scoreRows(rows) {
  for (const row of rows) row.move24hAbs = Math.abs(row.change24hPct);

  const ranks = new Map(METRICS.map((m) => [m.key, new Map()]));

  for (const metric of METRICS) {
    // A metric that came back null (e.g. the window is too short for ADX) is
    // simply left out of the average rather than scored as zero.
    const present = rows.filter((r) => Number.isFinite(r[metric.key]));
    const sorted = present.map((r) => r[metric.key]).sort((a, b) => a - b);

    for (const row of present) {
      const below = sorted.findIndex((value) => value >= row[metric.key]);
      const percentile = sorted.length > 1 ? below / (sorted.length - 1) : 1;
      ranks.get(metric.key).set(row.symbol, metric.lowerIsBetter ? 1 - percentile : percentile);
    }
  }

  for (const row of rows) {
    const parts = METRICS.map((m) => ranks.get(m.key).get(row.symbol)).filter((v) => Number.isFinite(v));
    row.metricsUsed = parts.length;
    row.score = parts.length ? parts.reduce((sum, v) => sum + v, 0) / parts.length : 0;
  }

  rows.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return rows;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmt(value, digits = 2, suffix = '') {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits) + suffix;
}

function fmtSigned(value, digits = 2, suffix = '') {
  if (!Number.isFinite(value)) return '-';
  return (value >= 0 ? '+' : '') + value.toFixed(digits) + suffix;
}

function pad(text, width, right = false) {
  const value = String(text);
  return right ? value.padStart(width) : value.padEnd(width);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function printRanking(rows, top) {
  console.log(
    `${pad('#', 3, true)} | ${pad('symbol', 12)} | ${pad('score', 5, true)} | ${pad('dir', 3)} | ` +
      `${pad('24h%', 7, true)} | ${pad('drift%', 7, true)} | ${pad('ER', 5, true)} | ${pad('ADX', 5, true)} | ` +
      `${pad('atr%', 6, true)} | ${pad('range%', 7, true)} | ${pad('24h vol', 9, true)} | ${pad('OIΔ6h', 9, true)} | ${pad('price', 12, true)}`
  );
  console.log('-'.repeat(140));

  rows.slice(0, top).forEach((row, index) => {
    const dir = row.change24hPct >= 0 ? 'UP' : 'DN';
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(row.symbol, 12)} | ${pad(row.score.toFixed(3), 5, true)} | ${pad(dir, 3)} | ` +
        `${pad(fmtSigned(row.change24hPct, 2), 7, true)} | ${pad(fmt(row.driftPct, 2), 7, true)} | ` +
        `${pad(fmt(row.er, 3), 5, true)} | ${pad(fmt(row.adx, 1), 5, true)} | ` +
        `${pad(fmt(row.atrPct, 2), 6, true)} | ${pad(fmt(row.rangePct, 2), 7, true)} | ` +
        `${pad(money(row.turnoverUsd), 9, true)} | ${pad(money(row.oiChange6hUsd), 9, true)} | ${pad(row.price, 12, true)}`
    );
  });
  console.log('  dir = 24h direction; drift% = |net window move|; ER 0..1 net move/travel; range% = window band width');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const res = args.res ? String(args.res) : DEFAULTS.res;
  if (!RESOLUTION_SECONDS[res]) {
    console.error(`Unsupported --res "${res}". Use one of: ${Object.keys(RESOLUTION_SECONDS).join(' ')}`);
    process.exit(1);
  }

  const days = Number(args.days) || DEFAULTS.days;
  const top = Number(args.top) || DEFAULTS.top;
  const universe = Number(args.universe) || DEFAULTS.universe;
  const conc = Number(args.conc) || DEFAULTS.conc;
  const minvol = args.minvol !== undefined ? Number(args.minvol) : DEFAULTS.minvol;
  const dir = args.dir ? String(args.dir).toLowerCase() : DEFAULTS.dir;
  const gates = {
    minadx: args.minadx !== undefined ? Number(args.minadx) : DEFAULTS.minadx,
    miner: args.miner !== undefined ? Number(args.miner) : DEFAULTS.miner,
  };
  const symbols = args.symbols ? String(args.symbols).split(',') : null;

  const barSec = RESOLUTION_SECONDS[res];
  const expectedBars = Math.max(30, Math.floor((days * 86400) / barSec));
  // Download a bit more than the window needs so the oldest bar of the window is
  // always a complete one, then slice down to exactly `expectedBars`.
  const fetchBars = expectedBars + Math.max(20, Math.ceil(expectedBars * 0.3));

  console.log(`\nDelta trend scanner — ${res} bars, ${days}d window`);
  console.log('='.repeat(140));

  const { list, missing, ranked, eligible } = await loadUniverse({ universe, minvol, symbols });

  if (missing.length) console.log(`Unknown symbols ignored: ${missing.join(', ')}`);
  if (!list.length) {
    console.error(
      ranked
        ? `No perpetual had >= $${minvol.toLocaleString()} of 24h turnover. Lower --minvol.`
        : 'No symbols to scan.'
    );
    process.exit(1);
  }

  console.log(
    ranked
      ? `Universe: top ${list.length} of ${eligible} perpetuals by 24h turnover ` +
          `(floor $${minvol.toLocaleString()}), turnover ${money(list[list.length - 1].turnoverUsd)} -> ${money(list[0].turnoverUsd)}`
      : `Universe: ${list.length} symbol(s) requested explicitly`
  );
  console.log(`Downloading ${list.length} x ~${expectedBars} ${res} bars from Delta...`);

  const started = Date.now();
  const analyzed = await mapWithConcurrency(list, conc, async (entry) => {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - fetchBars * barSec;

    try {
      const { candles } = await downloadCandles({ symbol: entry.symbol, resolution: res, fromSec, toSec });
      // Delta returns the newest bars it has; a symbol listed mid-window would
      // look artificially clean, so require near-full coverage.
      if (candles.length < expectedBars * MIN_BAR_COVERAGE) {
        return { ...entry, skipped: `${candles.length}/${expectedBars} bars` };
      }
      const metrics = analyze(candles.slice(-expectedBars));
      if (!metrics) return { ...entry, skipped: 'no usable prices' };
      return { ...entry, ...metrics };
    } catch (error) {
      return { ...entry, skipped: error.message };
    }
  });

  const scored = analyzed.filter((row) => !row.skipped);
  const skipped = analyzed.filter((row) => row.skipped);

  // Direction filter (on the 24h change) and the absolute trend gates.
  const rows = [];
  const gatedOut = [];
  for (const row of scored) {
    if (dir === 'up' && row.change24hPct < 0) continue;
    if (dir === 'down' && row.change24hPct >= 0) continue;

    const failed = [];
    if (gates.minadx > 0 && !(row.adx >= gates.minadx)) failed.push(`ADX ${fmt(row.adx, 1)}<${gates.minadx}`);
    if (gates.miner > 0 && !(row.er >= gates.miner)) failed.push(`ER ${fmt(row.er, 3)}<${gates.miner}`);

    if (failed.length) gatedOut.push(`${row.symbol} (${failed.join(', ')})`);
    else rows.push(row);
  }

  console.log(
    `Scored ${scored.length} symbol(s) in ${Date.now() - started}ms` +
      (skipped.length ? `, skipped ${skipped.length}` : '')
  );
  if (skipped.length) console.log(`  skipped: ${skipped.map((r) => `${r.symbol} (${r.skipped})`).join(', ')}`);

  if (!rows.length) {
    console.log(
      `\nNothing passed the trend gates (ADX>=${gates.minadx || 'off'} ER>=${gates.miner || 'off'}, dir=${dir}).`
    );
    if (gatedOut.length) console.log(`  excluded: ${gatedOut.join(', ')}`);
    console.log('  No market in this universe is trending right now — that is the answer. Loosen --minadx/--miner or wait.\n');
    return;
  }

  if (gatedOut.length) {
    console.log(
      `  gates ADX>=${gates.minadx || 'off'} ER>=${gates.miner || 'off'} dir=${dir}` +
        ` excluded ${gatedOut.length}: ${gatedOut.join(', ')}`
    );
  }

  scoreRows(rows);

  console.log(
    '\nEvery column is a raw reading; score blends them by rank (1.000 = the most trending on every measure).'
  );
  console.log('move24h%/drift%/atr%/range% in % of price, ER 0..1 (net move / travel), ADX index points\n');
  printRanking(rows, top);

  console.log(
    `\n${pad('avg', 12)} 24h%=${fmt(avg(scored, 'change24hPct'), 2)}  drift%=${fmt(avg(scored, 'driftPct'), 2)}  ` +
      `ER=${fmt(avg(scored, 'er'), 3)}  ADX=${fmt(avg(scored, 'adx'), 1)}  range%=${fmt(avg(scored, 'rangePct'), 2)}`
  );
  console.log('  (the average of every scored symbol, gates aside — a pick should beat it on ER and ADX)\n');
}

function avg(rows, key) {
  const values = rows.map((r) => Number(r[key])).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

main().catch((error) => {
  console.error('SCAN FAILED:', error.message);
  process.exit(1);
});
