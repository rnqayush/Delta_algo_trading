// Which Delta perpetuals does OpenCloseCross1m actually SUIT?
//
// The live strategy is always-in-market on the 1m chart: SMMA(8) of the close
// crossing SMMA(8) of the open fires an entry, and the next opposite cross
// reverses it. Two things therefore decide whether a symbol is worth trading:
//
//   1. HOW OFTEN it fires. The two SMMAs cross when the recent open/close
//      averages keep swapping sides. A choppy, mean-reverting book crosses
//      hundreds of times a day; a symbol that trends for hours barely crosses,
//      so the position just sits there and "takes too long".
//   2. Whether those flips make money. Every flip is two market legs, so the
//      gross move between crosses has to beat ~14 bps of round-trip cost
//      (taker + slip in, taker + slip out).
//
// This scans EVERY live Delta perpetual (not a turnover subset) on 1m bars and
// replays the strategy exactly as deployed, then ranks by a blend of flip
// frequency and net %/day. The faded mapping is the live one: a bull cross
// (close SMMA over open SMMA) opens a SHORT, a bear cross opens a LONG
// (INVERT_SIGNALS = true in the strategy file). --nofade runs the published,
// non-inverted mapping instead.
//
// The 1m resolution is not optional — the strategy trades 1m candles only, so
// "suitable for it" can only be judged on 1m.
//
// Faithful to the live engine:
//   * cross read off the last CLOSED bar, no look-ahead, no repainting;
//   * the first cross opens, every later cross closes and re-opens (1 flip);
//   * a stop-out leaves the bot FLAT until the next cross (the strategy marks
//     the cross as traded), which is modelled when --slpct is on.
//
//   node scanners/occ-scanner.js
//   node scanners/occ-scanner.js --days 5 --minfreq 40
//   node scanners/occ-scanner.js --minvol 1000000 --top 10
//   node scanners/occ-scanner.js --slpct 2          # the live 10%-ROE stop at 5x
//   node scanners/occ-scanner.js --symbols BTCUSD,ETHUSD,AINUSD --nofade
//
// Options:
//   --days      look-back window in days                        (default 3)
//   --top       rows to print                                   (default 5)
//   --universe  cap on symbols scanned, 0 = every live perp     (default 0)
//   --minvol    minimum 24h turnover in USD, 0 disables         (default 1000000)
//   --minfreq   minimum flips per day                           (default 0)
//   --minnet    minimum net % of notional per day               (default 0)
//   --fee       taker fee in bps per leg                        (default 5)
//   --slip      slippage in bps per leg                         (default 2)
//   --slpct     adverse price % that trips the stop, 0 = none   (default 0)
//   --nofade    use the published (non-inverted) mapping
//   --symbols   explicit comma-separated list
//   --conc      parallel downloads                              (default 6)
//
// --slpct is a PRICE move, not the ROE the strategy constant uses. The live
// stop is 10% of blocked margin, which at Lx leverage is a 10/L % price move:
// pass 2 for the 5x account it currently runs on. Bar highs/lows are used to
// detect the touch, filled at the stop price (gap slippage is ignored).
//
// Liquidity is an absolute GATE, not a sort key, for the same reason the range
// scanner gates band width: the score is a rank, so on its own it always crowns
// a winner. Left ungated the top of the table fills with $60K/day micro-caps
// whose modelled 14 bps round trip bears no relation to what a real order would
// pay. Symbols dropped for size are listed (with their flip rate) rather than
// hidden, and --minvol 0 puts them back in the ranking.
//
// A symbol is also scored on day-consistency (days+): the share of days that
// ended net-positive, counting only days with a real sample of flips. Small and
// consistent is the stated goal; an edge that lives on one explosive session is
// a lottery ticket wearing the same numbers. Even so, a 3-day window is short —
// re-run with --days 5 and --days 7 and keep only what survives all of them.
//
// Data: downloaded fresh via backtest/lib/data.js (downloadCandles), never the
// caching wrapper, so the long backtest series in backtest/data is not
// overwritten with a few days of data.

'use strict';

const { downloadCandles } = require('../backtest/lib/data');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';

// Identical to the live strategy file.
const MA_LEN = 8;
const MIN_BARS = 60; // fewer 1m bars than this cannot say anything about frequency
const MIN_TRADES = 10; // fewer flips than this is noise, not a rate

const DEFAULTS = {
  days: 3,
  top: 5,
  universe: 0, // 0 = every live perpetual
  minvol: 1000000, // ranking gate on 24h turnover; 0 = no floor
  minfreq: 0,
  minnet: 0,
  fee: 5, // taker bps
  slip: 2, // bps
  slpct: 0, // adverse price % that trips the stop
  invert: true, // the live INVERT_SIGNALS
  conc: 6,
  symbols: null,
};

// A window only counts if nearly all its bars are present, otherwise a late
// listing looks artificially quiet and its flip rate is meaningless.
const MIN_BAR_COVERAGE = 0.85;

// ---------------------------------------------------------------------------
// Indicators — identical maths to the strategy
// ---------------------------------------------------------------------------

// Pine's SMMA (ta.rma): SMA seeds index len-1, then v = (v[1]*(len-1) + src)/len.
function smma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// ---------------------------------------------------------------------------
// Simulation — the live always-in reversal, fade included
// ---------------------------------------------------------------------------

// The side held after a cross. The faded mapping is the live one.
function sideFor(kind, invert) {
  if (kind === 'bull') return invert ? 'short' : 'long';
  return invert ? 'long' : 'short';
}

// Replays the strategy over one 1m series and returns the flips.
//
// One flip = one position, from the cross that opened it to the cross that
// reversed it. Its return is the move from entry close to exit close in the
// direction actually held, so a fade that catches a pullback is a positive
// number. costPerFlip charges both market legs against that flip, which is what
// "net" means here.
function simulate(candles, { invert, slPct, costPerFlip }) {
  const closeMA = smma(candles.map((c) => c.close), MA_LEN);
  const openMA = smma(candles.map((c) => c.open), MA_LEN);
  const n = candles.length;
  const stopFrac = slPct > 0 ? slPct / 100 : 0;

  const trades = [];
  let pos = null;
  let openSide = null; // the side held on the final bar

  const closeAt = (price, index, reason) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (dir * (price - pos.entry)) / pos.entry;
    trades.push({
      gross,
      net: gross - costPerFlip,
      bars: index - pos.index,
      reason,
      side: pos.side,
      time: candles[index].time,
    });
    pos = null;
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];

    // The stop first: it can only be touched on a bar AFTER the entry bar, and
    // it can fire between crosses. After a stop-out the bot is flat until the
    // next cross (the strategy marks the cross as already traded).
    if (pos && stopFrac > 0 && i > pos.index) {
      const dir = pos.side === 'long' ? 1 : -1;
      const stopPrice = pos.entry * (1 - dir * stopFrac);
      if ((dir > 0 && bar.low <= stopPrice) || (dir < 0 && bar.high >= stopPrice)) {
        closeAt(stopPrice, i, 'stop');
      }
    }

    const c0 = closeMA[i - 1];
    const o0 = openMA[i - 1];
    const c1 = closeMA[i];
    const o1 = openMA[i];
    if (c0 == null || o0 == null || c1 == null || o1 == null) continue;

    let kind = null;
    if (c0 <= o0 && c1 > o1) kind = 'bull';
    else if (c0 >= o0 && c1 < o1) kind = 'bear';
    if (!kind) continue;

    const side = sideFor(kind, invert);
    openSide = side;
    if (pos && pos.side === side) continue; // pyramiding = 0
    if (pos) closeAt(bar.close, i, 'flip');
    pos = { side, entry: bar.close, index: i };
  }

  if (pos) closeAt(candles[n - 1].close, n - 1, 'eod');
  return { trades, openSide };
}

function analyze(candles, opts) {
  if (candles.length < MIN_BARS) return null;
  const price = Number(candles[candles.length - 1].close);
  if (!(price > 0)) return null;

  const { trades, openSide } = simulate(candles, opts);
  const n = trades.length;
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  if (!(spanDays > 0)) return null;

  const mean = (f) => (n ? trades.reduce((s, t) => s + f(t), 0) / n : null);
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);

  const grossPct = sum((t) => t.gross) * 100;
  const netPct = sum((t) => t.net) * 100;
  const costPct = grossPct - netPct;

  // Day-by-day consistency: a symbol whose whole edge comes from one explosive
  // day is not "small and consistent", it is a lottery ticket. Only days with a
  // real sample of flips are counted, so one lucky trade cannot carry a day.
  const byDay = new Map();
  for (const trade of trades) {
    const key = Math.floor(trade.time / 86400);
    const day = byDay.get(key) || { net: 0, flips: 0 };
    day.net += trade.net;
    day.flips += 1;
    byDay.set(key, day);
  }
  const countedDays = [...byDay.values()].filter((d) => d.flips >= 5);
  const greenDays = countedDays.filter((d) => d.net > 0).length;

  return {
    bars: candles.length,
    spanDays,
    trades: n,
    perDay: n / spanDays,
    holdMin: mean((t) => t.bars),
    winPct: n ? (trades.filter((t) => t.gross > 0).length / n) * 100 : null,
    avgBps: n ? mean((t) => Math.abs(t.gross)) * 1e4 : null,
    grossPerDay: grossPct / spanDays,
    netPerDay: netPct / spanDays,
    costPerDay: costPct / spanDays,
    stopShare: n ? (trades.filter((t) => t.reason === 'stop').length / n) * 100 : null,
    dayCount: countedDays.length,
    greenDays,
    greenDayPct: countedDays.length ? (greenDays / countedDays.length) * 100 : null,
    price,
    openSide,
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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Every live perpetual, richest first. This does NOT filter or cap by default:
// "suitable for the strategy" is a per-symbol property and the scan should see
// all of them. Liquidity is applied later as a RANKING gate, so a thin symbol
// is still measured (and reported as excluded) rather than silently ignored.
async function loadUniverse({ universe, symbols }) {
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
      contractValue: Number(product.contract_value) || 0,
    });
  }

  if (symbols && symbols.length) {
    const wanted = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    const missing = wanted.filter((s) => !rows.has(s));
    return { list: wanted.filter((s) => rows.has(s)).map((s) => rows.get(s)), missing, eligible: rows.size };
  }

  const sorted = [...rows.values()]
    .filter((r) => r.price > 0)
    .sort((a, b) => b.turnoverUsd - a.turnoverUsd);
  return { list: universe > 0 ? sorted.slice(0, universe) : sorted, missing: [], eligible: rows.size };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Frequency, edge and day-consistency all matter and none should dominate, so
// the score is the mean of their rank percentiles. 1.000 = fires the most, earns
// the most per day AND earns it on the most days, of anything scanned.
function percentileRanks(rows, key) {
  const present = rows.filter((r) => Number.isFinite(r[key]));
  const sorted = present.map((r) => r[key]).sort((a, b) => a - b);
  const map = new Map();
  for (const row of present) {
    const below = sorted.findIndex((value) => value >= row[key]);
    map.set(row.symbol, sorted.length > 1 ? below / (sorted.length - 1) : 1);
  }
  return map;
}

function scoreRows(rows) {
  const freq = percentileRanks(rows, 'perDay');
  const net = percentileRanks(rows, 'netPerDay');
  const green = percentileRanks(rows, 'greenDayPct');

  for (const row of rows) {
    const parts = [freq.get(row.symbol), net.get(row.symbol), green.get(row.symbol)].filter((v) =>
      Number.isFinite(v)
    );
    row.score = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : 0;
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

const signed = (value, digits = 3) =>
  Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : '-';

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
    `${pad('#', 3, true)} | ${pad('symbol', 12)} | ${pad('score', 5, true)} | ${pad('flips', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('hold', 6, true)} | ${pad('win%', 5, true)} | ${pad('days+', 6, true)} | ` +
      `${pad('bps/trd', 7, true)} | ${pad('gross%/d', 8, true)} | ${pad('cost%/d', 7, true)} | ` +
      `${pad('net%/d', 7, true)} | ${pad('24h vol', 8, true)} | ${pad('side', 5)}`
  );
  console.log('-'.repeat(134));

  rows.slice(0, top).forEach((row, index) => {
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(row.symbol, 12)} | ${pad(row.score.toFixed(3), 5, true)} | ` +
        `${pad(row.trades, 6, true)} | ${pad(fmt(row.perDay, 1), 6, true)} | ` +
        `${pad(fmt(row.holdMin, 1, 'm'), 6, true)} | ${pad(fmt(row.winPct, 1), 5, true)} | ` +
        `${pad(`${row.greenDays}/${row.dayCount}`, 6, true)} | ` +
        `${pad(fmt(row.avgBps, 1), 7, true)} | ${pad(signed(row.grossPerDay, 2), 8, true)} | ` +
        `${pad(fmt(row.costPerDay, 2), 7, true)} | ${pad(signed(row.netPerDay, 2), 7, true)} | ` +
        `${pad(money(row.turnoverUsd), 8, true)} | ${pad(row.openSide || '-', 5)}`
    );
  });
}

function avg(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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

  const days = Number(args.days) || DEFAULTS.days;
  const top = Number(args.top) || DEFAULTS.top;
  const universe = args.universe !== undefined ? Number(args.universe) : DEFAULTS.universe;
  const minvol = args.minvol !== undefined ? Number(args.minvol) : DEFAULTS.minvol;
  const conc = Number(args.conc) || DEFAULTS.conc;
  const invert = args.nofade ? false : DEFAULTS.invert;
  const symbols = args.symbols ? String(args.symbols).split(',') : null;

  const fee = (args.fee !== undefined ? Number(args.fee) : DEFAULTS.fee) / 1e4;
  const slip = (args.slip !== undefined ? Number(args.slip) : DEFAULTS.slip) / 1e4;
  const slPct = args.slpct !== undefined ? Number(args.slpct) : DEFAULTS.slpct;
  // One flip = two market legs (close + re-open).
  const costPerFlip = 2 * (fee + slip);

  // --minnet defaults to 0: break-even is a hard requirement, since a symbol
  // that fires often and loses money is the worst possible pick. 0 is therefore
  // a real threshold here (unlike the range scanner's gates), so "disable" is
  // spelled --minnet off.
  const minnetArg = args.minnet;
  const minnet =
    minnetArg === undefined
      ? DEFAULTS.minnet
      : minnetArg === true || String(minnetArg).toLowerCase() === 'off'
        ? null
        : Number(minnetArg);

  const gates = {
    minvol,
    minfreq: args.minfreq !== undefined ? Number(args.minfreq) : DEFAULTS.minfreq,
    minnet,
  };
  const gateLabel = (value) => (value === null ? 'off' : value);

  const expectedBars = Math.floor((days * 86400) / 60);
  const fetchBars = expectedBars + Math.max(120, Math.ceil(expectedBars * 0.1));

  console.log('\nOpenCloseCross1m symbol scanner — 1m bars, last ' + days + 'd');
  console.log('='.repeat(126));
  console.log(
    `model   ${invert ? 'FADED (live INVERT_SIGNALS)' : 'published (non-inverted)'} always-in reversal, ` +
      `SMMA(${MA_LEN}) open/close cross, no look-ahead`
  );
  console.log(
    `costs   ${(fee * 1e4).toFixed(1)}bps taker + ${(slip * 1e4).toFixed(1)}bps slip per leg ` +
      `-> ${(costPerFlip * 1e4).toFixed(1)}bps per flip` +
      (slPct > 0 ? `, stop ${slPct}% adverse (flat until the next cross)` : ', no stop')
  );

  const { list, missing, eligible } = await loadUniverse({ universe, symbols });

  if (missing.length) console.log(`Unknown symbols ignored: ${missing.join(', ')}`);
  if (!list.length) {
    console.error('No symbols to scan.');
    process.exit(1);
  }

  console.log(
    universe > 0
      ? `Universe: top ${list.length} of ${eligible} live perpetuals by 24h turnover`
      : `Universe: all ${list.length} live perpetuals`
  );
  console.log(`Downloading ${list.length} x ~${expectedBars} 1m bars from Delta...`);

  const started = Date.now();
  const analyzed = await mapWithConcurrency(list, conc, async (entry) => {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - fetchBars * 60;

    try {
      const { candles } = await downloadCandles({ symbol: entry.symbol, resolution: '1m', fromSec, toSec });
      if (candles.length < expectedBars * MIN_BAR_COVERAGE) {
        return { ...entry, skipped: `${candles.length}/${expectedBars} bars` };
      }
      const metrics = analyze(candles.slice(-expectedBars), { invert, slPct, costPerFlip });
      if (!metrics) return { ...entry, skipped: 'no usable prices' };
      if (metrics.trades < MIN_TRADES) return { ...entry, skipped: `only ${metrics.trades} flips` };
      return { ...entry, ...metrics };
    } catch (error) {
      return { ...entry, skipped: error.message };
    }
  });

  const scored = analyzed.filter((row) => !row.skipped);
  const skipped = analyzed.filter((row) => row.skipped);

  const rows = [];
  const gatedOut = [];
  const tooThin = [];
  for (const row of scored) {
    // Liquidity is a gate, not a sort key. A $60K/day book cannot absorb a flip
    // every 30 seconds, so the modelled 14 bps round trip is fiction there
    // however good the signal looks — the symbol is named, not silently ranked.
    const thin = gates.minvol > 0 && !(row.turnoverUsd >= gates.minvol);
    const slow = gates.minfreq > 0 && !(row.perDay >= gates.minfreq);
    const losing = gates.minnet !== null && !(row.netPerDay >= gates.minnet);

    const failed = [];
    if (thin) failed.push(`vol ${money(row.turnoverUsd)}`);
    if (slow) failed.push(`freq ${fmt(row.perDay, 1)}`);
    if (losing) failed.push(`net ${signed(row.netPerDay, 2)}%`);

    if (failed.length) {
      gatedOut.push(`${row.symbol} (${failed.join(', ')})`);
      if (thin && !slow && !losing) tooThin.push(row);
    } else {
      rows.push(row);
    }
  }

  console.log(
    `Scanned ${scored.length} symbol(s) in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (skipped.length ? `, skipped ${skipped.length}` : '')
  );
  if (skipped.length) {
    console.log(`  skipped: ${skipped.slice(0, 12).map((r) => `${r.symbol} (${r.skipped})`).join(', ')}` +
      (skipped.length > 12 ? `, +${skipped.length - 12} more` : ''));
  }
  if (tooThin.length) {
    const names = tooThin
      .sort((a, b) => b.perDay - a.perDay)
      .slice(0, 8)
      .map((r) => `${r.symbol} ${fmt(r.perDay, 0)}/d net ${signed(r.netPerDay, 1)}%/d`);
    console.log(
      `  frequent but too thin to fill at the modelled slip (${tooThin.length}): ${names.join(', ')}`
    );
    console.log('    (they rank well on paper; on a book that size the real spread eats it — --minvol 0 to include)');
  }

  const gateText =
    `vol>=${money(gates.minvol)} freq>=${gateLabel(gates.minfreq)}/day net>=${gateLabel(gates.minnet)}%/day`;

  if (!rows.length) {
    console.log(`\nNothing passed the gates (${gateText}).`);
    if (gatedOut.length) console.log(`  excluded: ${gatedOut.slice(0, 20).join(', ')}`);
    console.log('  Loosen --minvol / --minfreq / --minnet, or widen --days.\n');
    return;
  }

  console.log(`  gates ${gateText} excluded ${gatedOut.length}`);

  scoreRows(rows);

  console.log('\nflips = crosses taken, /day = flip rate, hold = avg minutes in a position,');
  console.log('days+ = profitable days out of days with a real sample (consistency),');
  console.log('gross%/d = raw signal return per day, cost%/d = fees+slip, net%/d = what is left,');
  console.log('side = the side it would be holding on the last bar,');
  console.log('score blends flips/day, net%/d and days+ by rank.\n');
  printRanking(rows, top);

  console.log(
    `\n${pad('avg', 12)} flips/day=${fmt(avg(scored, 'perDay'), 1)}  hold=${fmt(avg(scored, 'holdMin'), 1, 'm')}  ` +
      `win%=${fmt(avg(scored, 'winPct'), 1)}  gross%/d=${signed(avg(scored, 'grossPerDay'), 2)}  ` +
      `net%/d=${signed(avg(scored, 'netPerDay'), 2)}`
  );
  console.log(`  (the average of every scanned symbol — a pick should beat it on both flips/day and net%/d)`);
  console.log(
    `\nThe window is only ${days} day(s) of 1m bars: a symbol whose whole edge came from one\n` +
      `session will look great here and die next week. Re-run with --days 5 and --days 7 before\n` +
      `committing — a pick that keeps its net%/d across all three windows is the real one.\n`
  );
}

main().catch((error) => {
  console.error('SCAN FAILED:', error.message);
  process.exit(1);
});

// node scanners/occ-scanner.js --days 5 --top 5
// node scanners/occ-scanner.js --days 7 --top 5