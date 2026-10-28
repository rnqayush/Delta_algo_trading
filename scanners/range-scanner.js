// Ranks every Delta perpetual by how STABLE and RANGE-BOUND it is right now.
//
// "Stable" here means low volatility inside a range that has not drifted — NOT
// "safe". A symbol can be stable and still lose money on fees; this only answers
// "which instruments are currently not going anywhere?", which is what a fade /
// mean-reversion approach needs and what a breakout approach should avoid.
//
// Six measures are computed over the last `--days`, then combined into one
// rank-based score (0..1, higher = calmer):
//
//   atr%     ATR(14) / price. The direct volatility reading: low = calm.
//   band%    (highest high - lowest low) / mid. The total width of the range.
//   bbw%     Bollinger(20, 2) width / mid. A squeeze reads low.
//   ER       Kaufman efficiency ratio over the whole window (net move / total
//            travel). ~0 = pure chop, ~1 = a straight line.
//   ADX      Wilder ADX(14). Low = no directional trend.
//   overlap  stability of the range itself: the window is split into 3 equal
//            segments, each segment's band is measured, and this is
//            (intersection of all three) / (union). 1.0 = every third of the
//            window traded the same band (a real consolidation); 0.0 = each
//            third sat somewhere else (a trend, or a range that moved).
//
// ER/ADX alone cannot tell a consolidating market from a slow drift, and band%
// alone cannot tell a tight range from a violent one — hence the blend. The
// score is the mean of the per-metric rank percentiles, so no metric's units
// dominate, and every raw number is printed so you can overrule the ranking.
//
// Liquidity comes first: instruments under `--minvol` of 24h turnover are
// dropped before any stability maths, because a dead market is trivially
// "stable" and is also impossible to enter or exit.
//
// Data: candles are always downloaded fresh via backtest/lib/data.js
// (downloadCandles — public endpoint, no keys, and deliberately NOT the caching
// wrapper, which would overwrite the long backtest series in backtest/data with
// a few days of data).
//
//   node scanners/range-scanner.js                          # what is ranging RIGHT NOW (last 60 min)
//   node scanners/range-scanner.js --now 180                # last 3 hours instead
//   node scanners/range-scanner.js --days 3 --res 5m        # wider context window
//   node scanners/range-scanner.js --universe 120 --minvol 250000
//   node scanners/range-scanner.js --maxadx 25 --minovlp 0.4
//   node scanners/range-scanner.js --symbols BTCUSD,ETHUSD,AINUSD
//
// Options:
//   --res       candle resolution: 1m 3m 5m 15m 30m 1h 4h 1d   (default 1m)
//   --now       recent window in MINUTES — "consolidating right now"  (default 60)
//   --days      look-back window in days; overrides --now       (default 3)
//   --top       rows to print                                   (default 15)
//   --universe  how many top-turnover symbols to download       (default 60)
//   --minvol    minimum 24h turnover in USD, 0 disables         (default 1000000)
//   --maxband   maximum band width in %, 0 disables             (default 15)
//   --maxadx    maximum ADX, 0 disables                         (default 35)
//   --minovlp   minimum range overlap, 0 disables               (default 0.25)
//   --symbols   explicit comma-separated list (skips turnover ranking)
//   --conc      parallel downloads                              (default 4)
//
// The window is what "right now" means: with --now 60 the band, ATR and overlap
// describe only the most recent hour, so a symbol that is ranging at this moment
// outranks one that ranged yesterday. Widen it (--now 180, --days 1) to ask
// about the session instead of the moment. Band width scales with the window, so
// a 60-minute --maxband is a much tighter number than a 3-day one.
//
// The score is a RANK, so on its own it always returns a "best" symbol even in a
// universe where nothing is ranging — the calmest of 24 wild markets still looks
// like a winner. --maxband/--maxadx/--minovlp are absolute gates: pass them and
// the symbol is consolidation, fail them and it is excluded, however good the
// rest of the universe looks. "Nothing passed the gates" is a real answer.

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('../backtest/lib/data');
const { atr, adx, efficiencyRatio } = require('../src/utils/indicators');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';

const DEFAULTS = {
  res: '1m',
  now: 60, // minutes of the most recent bars — the "right now" window
  days: 3,
  top: 15,
  universe: 60,
  minvol: 1000000,
  // Absolute gates. A rank only orders the universe; these decide whether an
  // instrument is a consolidation at all. 0 disables any one gate.
  maxband: 15,
  maxadx: 35,
  minovlp: 0.25,
  conc: 4,
  symbols: null,
};

// Which row fails which gate — null when it passes everything. A metric that
// came back null (window too short for ADX, say) fails its gate rather than
// sneaking through, because "unknown" is not evidence of a quiet range.
function gateFailure(row, gates) {
  const failed = [];
  if (gates.maxband > 0 && !(row.bandPct <= gates.maxband)) failed.push(`band ${fmt(row.bandPct, 2)}%>${gates.maxband}%`);
  if (gates.maxadx > 0 && !(row.adx <= gates.maxadx)) failed.push(`ADX ${fmt(row.adx, 1)}>${gates.maxadx}`);
  if (gates.minovlp > 0 && !(row.overlap >= gates.minovlp)) failed.push(`ovlp ${fmt(row.overlap, 2)}<${gates.minovlp}`);
  return failed.length ? failed.join(', ') : null;
}

// A window only counts if nearly all of its bars are present, otherwise a late
// listing masquerades as a quiet range (fewer bars => smaller extremes).
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
// and the cap keeps a scan to a sane number of downloads.
async function loadUniverse({ res, universe, minvol, symbols }) {
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
      tickSize: Number(product.tick_size) || 0,
      contractValue: Number(product.contract_value) || 0,
      leverage: Number(product.default_leverage) || 0,
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

// How much the range itself moved: the three segment bands' intersection over
// their union. 1 = stationary, 0 = every third traded elsewhere.
function rangeOverlap(candles, segments = 3) {
  const size = Math.floor(candles.length / segments);
  if (size < 10) return null; // not enough bars per third to mean anything

  const bands = [];
  for (let s = 0; s < segments; s += 1) {
    const from = s * size;
    const to = s === segments - 1 ? candles.length : (s + 1) * size;
    bands.push(extremes(candles.slice(from, to)));
  }

  const innerLow = Math.max(...bands.map((b) => b.low));
  const innerHigh = Math.min(...bands.map((b) => b.high));
  const outerLow = Math.min(...bands.map((b) => b.low));
  const outerHigh = Math.max(...bands.map((b) => b.high));

  const union = outerHigh - outerLow;
  if (!(union > 0)) return null;
  return Math.max(0, innerHigh - innerLow) / union;
}

// Bollinger(20, 2) width as a % of the middle band.
function bollingerWidthPct(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;

  const window = candles.slice(-period).map((c) => c.close);
  const mid = window.reduce((sum, value) => sum + value, 0) / period;
  if (!(mid > 0)) return null;

  const variance = window.reduce((sum, value) => sum + (value - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return ((2 * mult * sd) / mid) * 100;
}

function analyze(candles) {
  const n = candles.length;
  const price = Number(candles[n - 1].close);
  if (!(price > 0)) return null;

  const { high, low } = extremes(candles);
  if (!(high > low)) return null;
  const mid = (high + low) / 2;

  return {
    bars: n,
    price,
    mid,
    bandLow: low,
    bandHigh: high,
    bandPct: ((high - low) / mid) * 100,
    atrPct: ((lastNumber(atr(candles, 14)) ?? 0) / price) * 100,
    bbWidthPct: bollingerWidthPct(candles),
    // Net move / total travel across the whole window (~0 chop, ~1 straight line).
    er: lastNumber(efficiencyRatio(candles, n - 1)),
    adx: lastNumber(adx(candles, 14)),
    driftPct: (Math.abs(price - Number(candles[0].close)) / mid) * 100,
    overlap: rangeOverlap(candles),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Each metric becomes a percentile rank across the universe, oriented so 1 is
// always "calmer", and the score is their mean. Rank-based, so a metric measured
// in % and one measured in index points (ADX) count the same.
const METRICS = [
  { key: 'atrPct', label: 'atr%', lowerIsBetter: true },
  { key: 'bandPct', label: 'band%', lowerIsBetter: true },
  { key: 'bbWidthPct', label: 'bbw%', lowerIsBetter: true },
  { key: 'er', label: 'ER', lowerIsBetter: true },
  { key: 'adx', label: 'ADX', lowerIsBetter: true },
  { key: 'overlap', label: 'ovlp', lowerIsBetter: false },
];

function scoreRows(rows) {
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
    `${pad('#', 3, true)} | ${pad('symbol', 12)} | ${pad('score', 5, true)} | ${pad('24h vol', 8, true)} | ` +
      `${pad('atr%', 6, true)} | ${pad('band%', 6, true)} | ${pad('bbw%', 6, true)} | ` +
      `${pad('ER', 5, true)} | ${pad('ADX', 5, true)} | ${pad('ovlp', 5, true)} | ${pad('drift%', 6, true)} | ${pad('price', 12, true)}`
  );
  console.log('-'.repeat(120));

  rows.slice(0, top).forEach((row, index) => {
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(row.symbol, 12)} | ${pad(row.score.toFixed(3), 5, true)} | ` +
        `${pad(money(row.turnoverUsd), 8, true)} | ${pad(fmt(row.atrPct, 3), 6, true)} | ` +
        `${pad(fmt(row.bandPct, 2), 6, true)} | ${pad(fmt(row.bbWidthPct, 2), 6, true)} | ` +
        `${pad(fmt(row.er, 3), 5, true)} | ${pad(fmt(row.adx, 1), 5, true)} | ` +
        `${pad(fmt(row.overlap, 2), 5, true)} | ${pad(fmt(row.driftPct, 2), 6, true)} | ` +
        `${pad(row.price, 12, true)}`
    );
  });
}

// The band the top names are stuck in, which is what a fade strategy would
// trade: the edges are where rejections happen, `now` says which side price is
// resting on.
function printBands(rows, top) {
  console.log(`\nRange band — the top ${top} (where a fade would sit)`);
  console.log(
    `${pad('symbol', 12)} | ${pad('low', 12, true)} | ${pad('high', 12, true)} | ${pad('mid', 12, true)} | ` +
      `${pad('width%', 7, true)} | ${pad('now', 12, true)} | ${pad('pos', 6, true)}`
  );
  console.log('-'.repeat(96));

  for (const row of rows.slice(0, top)) {
    const width = row.bandHigh - row.bandLow;
    const position = width > 0 ? ((row.price - row.bandLow) / width) * 100 : 50;
    console.log(
      `${pad(row.symbol, 12)} | ${pad(row.bandLow, 12, true)} | ${pad(row.bandHigh, 12, true)} | ` +
        `${pad(row.mid.toFixed(6), 12, true)} | ${pad(fmt(row.bandPct, 2), 7, true)} | ` +
        `${pad(row.price, 12, true)} | ${pad(position.toFixed(0) + '%', 6, true)}`
    );
  }
  console.log('  pos = where price sits in the band (0% = at the low, 100% = at the high)');
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

  // The analysis window. `--now <minutes>` answers "what is consolidating right
  // now?" by measuring only the most recent N bars; `--days` is the wider-context
  // knob. With neither, the scanner defaults to "right now" (DEFAULTS.now).
  let nowMin = args.now !== undefined && args.now !== true ? Number(args.now) : null;
  if (nowMin === null && args.days === undefined) nowMin = DEFAULTS.now;
  const days = nowMin > 0 ? nowMin / 1440 : Number(args.days) || DEFAULTS.days;
  const top = Number(args.top) || DEFAULTS.top;
  const universe = Number(args.universe) || DEFAULTS.universe;
  const conc = Number(args.conc) || DEFAULTS.conc;
  const minvol = args.minvol !== undefined ? Number(args.minvol) : DEFAULTS.minvol;
  const gates = {
    maxband: args.maxband !== undefined ? Number(args.maxband) : DEFAULTS.maxband,
    maxadx: args.maxadx !== undefined ? Number(args.maxadx) : DEFAULTS.maxadx,
    minovlp: args.minovlp !== undefined ? Number(args.minovlp) : DEFAULTS.minovlp,
  };
  const symbols = args.symbols ? String(args.symbols).split(',') : null;

  const barSec = RESOLUTION_SECONDS[res];
  const expectedBars = Math.max(30, Math.floor((days * 86400) / barSec));
  // Download a bit more than the window needs so the oldest bar of the window is
  // always a complete one, then slice down to exactly `expectedBars`.
  const fetchBars = expectedBars + Math.max(20, Math.ceil(expectedBars * 0.3));
  const windowLabel = nowMin > 0 ? `last ${nowMin} min` : `${days}d`;

  console.log(`\nDelta range / stability scanner — ${res} bars, ${windowLabel} window`);
  console.log('='.repeat(120));

  const { list, missing, ranked, eligible } = await loadUniverse({ res, universe, minvol, symbols });

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
      // look artificially quiet, so require near-full coverage.
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

  const rows = [];
  const gatedOut = [];
  for (const row of scored) {
    const reason = gateFailure(row, gates);
    if (reason) gatedOut.push(`${row.symbol} (${reason})`);
    else rows.push(row);
  }

  console.log(
    `Scored ${scored.length} symbol(s) in ${Date.now() - started}ms` +
      (skipped.length ? `, skipped ${skipped.length}` : '')
  );
  if (skipped.length) console.log(`  skipped: ${skipped.map((r) => `${r.symbol} (${r.skipped})`).join(', ')}`);

  if (!rows.length) {
    console.log(
      `\nNothing passed the consolidation gates ` +
        `(band%<=${gates.maxband || 'off'} ADX<=${gates.maxadx || 'off'} ovlp>=${gates.minovlp || 'off'}).`
    );
    if (gatedOut.length) console.log(`  excluded: ${gatedOut.join(', ')}`);
    console.log('  No market in this universe is ranging right now — that is the answer. Loosen --maxband/--maxadx/--minovlp or wait.\n');
    return;
  }

  if (gatedOut.length) {
    console.log(
      `  gates band%<=${gates.maxband || 'off'} ADX<=${gates.maxadx || 'off'} ovlp>=${gates.minovlp || 'off'}` +
        ` excluded ${gatedOut.length}: ${gatedOut.join(', ')}`
    );
  }

  scoreRows(rows);

  console.log(
    '\nEvery column is a raw reading; score blends them by rank (1.000 = the calmest on every measure).'
  );
  console.log('atr%/band%/bbw% in % of price, ER 0..1 (net move / travel), ADX index points, ovlp 0..1 (range stayed put)\n');
  printRanking(rows, top);
  printBands(rows, Math.min(top, rows.length));

  console.log(
    `\n${pad('avg', 12)} atr%=${fmt(avg(scored, 'atrPct'), 3)}  band%=${fmt(avg(scored, 'bandPct'), 2)}  ` +
      `ER=${fmt(avg(scored, 'er'), 3)}  ADX=${fmt(avg(scored, 'adx'), 1)}  ovlp=${fmt(avg(scored, 'overlap'), 2)}`
  );
  console.log('  (the average of every scored symbol, gates aside — a pick should beat it on volatility and overlap)\n');
}

function avg(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

main().catch((error) => {
  console.error('SCAN FAILED:', error.message);
  process.exit(1);
});
