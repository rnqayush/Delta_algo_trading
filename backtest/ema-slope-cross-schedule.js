// EmaSlopeCross1m with a TIME-SCHEDULED signal inversion.
//
// THE IDEA UNDER TEST
// -------------------
// Run the ChartArt EMA Slope + EMA Cross rule on the 1m feed, but flip
// (invert) the signal only during part of the day:
//
//   normal window  : 09:00 - 18:00 local  -> signals as written (INVERT=false)
//   inverted window: 22:00 - 06:00 local  -> signals faded    (INVERT=true)
//   everywhere else -> NO trading (flat); any open position is closed.
//
// Times are LOCAL; the clock offset is --tz-offset (default +8 = Asia/Shanghai)
// so the run is deterministic regardless of the machine timezone.
//
// Signal maths match backtest/ema-slope-cross.js and the live port
// src/strategies/strategies/emaSlopeCross1m.js: EMA(2)/EMA(4)/EMA(20) on the
// close, a CONTRARIAN always-in reversal system (no stop, no target).
//
//   node backtest/ema-slope-cross-schedule.js --symbols EVAAUSD,BTCUSD --days 14
//   node backtest/ema-slope-cross-schedule.js --symbols BTCUSD,ETHUSD,SOLUSD --days 14 --free
//
// Options:
//   --symbols     comma list (default TRADING_SYMBOL or BTCUSD)
//   --tf          candle resolution, default 1m
//   --days        look-back window in days, default 14
//   --norm        normal-window hours, default 9-18
//   --inv         inverted-window hours, default 22-6
//   --tz-offset   local clock offset in hours, default 8
//   --len1/2/3    EMA lengths, defaults 2 / 4 / 20
//   --notional    notional per position as x equity, default 1.0
//   --capital     starting equity, default 10000
//   --fee/--slip  bps per leg, defaults 5 / 0 (=10 bps per flip)
//   --free        ignore fees and slippage

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 14, len1: 2, len2: 4, len3: 20,
  notional: 1.0, capital: 10000, fee: 5, slip: 0, free: false,
  norm: '9-18', inv: '22-6', tzOffset: 8,
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

// Parse "9-18" / "22-6" into { from, to } (hours, may wrap past midnight).
function parseWindow(spec) {
  const m = String(spec).split('-').map((x) => Number(x.trim()));
  return { from: m[0], to: m[1] };
}

// Which window covers this local hour? null = the gap (trade nothing).
function windowAt(hour, norm, inv) {
  const within = (w) => (w.from < w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to);
  if (within(norm)) return { name: 'normal', invert: false };
  if (within(inv)) return { name: 'invert', invert: true };
  return null;
}

const hourOf = (sec, tzOffset) => Math.floor(((((sec + tzOffset * 3600) % 86400) + 86400) % 86400) / 3600);

// ---------------------------------------------------------------------------
// Simulation: always-in reversal inside the active window, flat in the gap.
// mode: 'schedule' | 'normal' | 'invert'  (the last two trade 24h, for baseline)
// ---------------------------------------------------------------------------
function simulate(candles, opts) {
  const { len1, len2, len3, notional, capital, costPerLeg, norm, inv, tzOffset, mode } = opts;
  const n = candles.length;
  const O = candles.map((c) => c.open);
  const C = candles.map((c) => c.close);
  const MA1 = emaSeries(C, len1);
  const MA2 = emaSeries(C, len2);
  const MA3 = emaSeries(C, len3);

  const trades = [];
  let signals = 0;
  let activeBars = 0;
  let equity = capital;
  let peak = equity;
  let maxDD = 0;

  let dir = 0;
  let entryPx = 0;
  let entryIdx = 0;
  let entrySession = null;
  let pending = null;    // desired direction to execute at the NEXT bar's open
  let pendingSession = null;

  const warm = Math.max(len1, len2, len3) + 1;

  const closeTrade = (fillPx, idx) => {
    const gross = dir * (fillPx / entryPx - 1);
    const net = gross * notional - 2 * costPerLeg * notional;
    equity *= 1 + net;
    trades.push({
      side: dir > 0 ? 'long' : 'short',
      session: entrySession,
      entry: entryPx,
      exit: fillPx,
      net: net * 100,
      bars: idx - entryIdx,
      time: candles[idx].time,
    });
    dir = 0;
  };

  for (let i = warm; i < n; i += 1) {
    // --- execute the pending decision at THIS bar's open ---
    if (pending !== null && pending !== dir) {
      if (dir !== 0) closeTrade(O[i], i);
      if (pending !== 0) {
        dir = pending;
        entryPx = O[i];
        entryIdx = i;
        entrySession = pendingSession;
      }
      pending = null;
    }

    // --- mark-to-market drawdown ---
    if (dir !== 0) {
      const mtm = equity * (1 + dir * (C[i] / entryPx - 1) * notional);
      if (mtm > peak) peak = mtm;
      maxDD = Math.max(maxDD, ((peak - mtm) / peak) * 100);
    } else if (equity > peak) {
      peak = equity;
    }

    // --- decide on this bar's close ---
    if (MA1[i] == null || MA1[i - 1] == null || MA2[i] == null || MA2[i - 1] == null || MA3[i] == null || MA3[i - 1] == null) {
      continue;
    }

    let win;
    if (mode === 'schedule') win = windowAt(hourOf(candles[i].time, tzOffset), norm, inv);
    else win = { name: 'all', invert: mode === 'invert' };
    if (win) activeBars += 1;

    if (!win) { // gap -> be flat
      pending = 0;
      continue;
    }

    const dPrice = C[i] - C[i - 1];
    const dMA1 = MA1[i] - MA1[i - 1];
    const dMA2 = MA2[i] - MA2[i - 1];

    const xUnderMA3 = C[i - 1] >= MA3[i - 1] && C[i] < MA3[i];
    const xOverMA3 = C[i - 1] <= MA3[i - 1] && C[i] > MA3[i];
    const xUnderMA1 = C[i - 1] >= MA1[i - 1] && C[i] < MA1[i];
    const xOverMA1 = C[i - 1] <= MA1[i - 1] && C[i] > MA1[i];

    let long = xUnderMA3 || (dPrice < 0 && dMA1 < 0 && xUnderMA1 && dMA2 > 0);
    let short = xOverMA3 || (dPrice > 0 && dMA1 > 0 && xOverMA1 && dMA2 < 0);
    if (win.invert) { const t = long; long = short; short = t; }
    if (long || short) signals += 1;

    // Short wins ties (Pine submits both entries; the short lands last).
    if (short) { pending = -1; pendingSession = win.name; }
    else if (long) { pending = 1; pendingSession = win.name; }
    else pending = dir; // no signal -> hold what we have (always-in inside the window)
  }

  if (dir !== 0) closeTrade(C[n - 1], n - 1);

  return { trades, signals, activeBars, bars: n, equity, capital, maxDD };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function analyze(res, spanDays) {
  const { trades, signals, activeBars, bars, equity, capital, maxDD } = res;
  const base = {
    bars, signals, activeBars, activePct: (activeBars / bars) * 100,
    trades: trades.length, returnPct: (equity / capital - 1) * 100, maxDD,
  };
  if (!trades.length) return { ...base, empty: true, winPct: 0, avgNet: 0, profitFactor: 0, longPct: 0, perDay: 0 };

  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.net > 0);
  const gw = sum((t) => Math.max(t.net, 0));
  const gl = Math.abs(sum((t) => Math.min(t.net, 0)));
  const sess = (name) => {
    const st = trades.filter((t) => t.session === name);
    return { count: st.length, net: st.reduce((s, t) => s + t.net, 0) };
  };
  return {
    ...base,
    winPct: (wins.length / n) * 100,
    avgNet: sum((t) => t.net) / n,
    profitFactor: gl > 0 ? gw / gl : Infinity,
    longPct: (trades.filter((t) => t.side === 'long').length / n) * 100,
    perDay: n / spanDays,
    normal: sess('normal'),
    invert: sess('invert'),
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
    if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

const num = (v, d) => (v !== undefined && v !== true ? Number(v) : d);
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

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;

  const norm = parseWindow(args.norm || DEFAULTS.norm);
  const inv = parseWindow(args.inv || DEFAULTS.inv);
  const tzOffset = num(args['tz-offset'], DEFAULTS.tzOffset);

  const opts = {
    len1: num(args.len1, DEFAULTS.len1),
    len2: num(args.len2, DEFAULTS.len2),
    len3: num(args.len3, DEFAULTS.len3),
    notional: num(args.notional, DEFAULTS.notional),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
    norm,
    inv,
    tzOffset,
  };

  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  console.log(`\nEmaSlopeCross1m — scheduled invert  (${tf} bars, last ${days}d, tz UTC+${tzOffset})`);
  console.log(
    `  NORMAL window  ${hh(norm.from)}-${hh(norm.to)}  (INVERT=false)   ` +
      `INVERTED window ${hh(inv.from)}-${hh(inv.to)}  (INVERT=true)   gap = flat`
  );
  console.log(
    `  EMA ${opts.len1}/${opts.len2}/${opts.len3} | always-in reversal, no stop/target | ` +
      `costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)} bps/flip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 50) { rows.push({ symbol, skipped: `only ${candles.length} bars` }); continue; }
      const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
      const sched = analyze(simulate(candles, { ...opts, mode: 'schedule' }), spanDays);
      const allN = analyze(simulate(candles, { ...opts, mode: 'normal' }), spanDays);
      const allI = analyze(simulate(candles, { ...opts, mode: 'invert' }), spanDays);
      rows.push({ symbol, bars: candles.length, sched, allN, allI });
    } catch (error) {
      rows.push({ symbol, skipped: error.message });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('act%', 5, true)} | ${pad('trades', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('avg%', 6, true)} | ${pad('PF', 5, true)} | ` +
      `${pad('long%', 6, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(112));

  rows.forEach((r, index) => {
    if (r.skipped) { console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`); return; }
    const s = r.sched;
    if (s.empty) { console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(fmt(s.activePct, 0), 5, true)} | no trades`); return; }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(fmt(s.activePct, 0), 5, true)} | ${pad(s.trades, 6, true)} | ` +
        `${pad(fmt(s.perDay, 1), 6, true)} | ${pad(fmt(s.winPct, 1), 5, true)} | ${pad(signed(s.avgNet, 3), 6, true)} | ${pad(fmt(s.profitFactor, 2), 5, true)} | ` +
        `${pad(fmt(s.longPct, 0), 6, true)} | ${pad(signed(s.returnPct, 2), 9, true)} | ${pad(fmt(s.maxDD, 1), 7, true)}`
    );
  });

  // ---- per-session split of the SCHEDULED run -----------------------------
  console.log(
    `\n${pad('session split', 13)} | ${pad('symbol', 10)} | ${pad('norm#', 6, true)} | ${pad('norm net%', 10, true)} | ` +
      `${pad('inv#', 6, true)} | ${pad('inv net%', 10, true)}`
  );
  console.log('-'.repeat(70));
  for (const r of rows) {
    if (r.skipped) continue;
    const s = r.sched;
    console.log(
      `${pad('', 13)} | ${pad(r.symbol, 10)} | ${pad(s.normal ? s.normal.count : 0, 6, true)} | ` +
        `${pad(signed(s.normal ? s.normal.net : 0, 2), 10, true)} | ${pad(s.invert ? s.invert.count : 0, 6, true)} | ` +
        `${pad(signed(s.invert ? s.invert.net : 0, 2), 10, true)}`
    );
  }

  // ---- aggregate vs the two 24h baselines ---------------------------------
  const ok = rows.filter((r) => !r.skipped && r.sched && !r.sched.empty);
  if (ok.length) {
    const mean = (f) => ok.reduce((a, r) => a + f(r), 0) / ok.length;
    const schedRet = mean((r) => r.sched.returnPct);
    const allNRet = mean((r) => r.allN.returnPct);
    const allIRet = mean((r) => r.allI.returnPct);
    const normNet = ok.reduce((a, r) => a + (r.sched.normal ? r.sched.normal.net : 0), 0);
    const invNet = ok.reduce((a, r) => a + (r.sched.invert ? r.sched.invert.net : 0), 0);
    const winners = ok.filter((r) => r.sched.returnPct > 0).length;

    console.log('\n' + '-'.repeat(70));
    console.log(`  ${winners} of ${ok.length} symbols net-positive under the schedule; mean return ${signed(schedRet, 2)}%`);
    console.log(`  Session contribution (sum of trade net across symbols): NORMAL ${signed(normNet, 1)}%  |  INVERTED ${signed(invNet, 1)}%`);
    console.log(`  Baselines, same cost model: 24h all-NORMAL ${signed(allNRet, 2)}%  |  24h all-INVERTED ${signed(allIRet, 2)}%`);
  }

  console.log(
    '\nact% = share of bars inside a trading window; return% compounds 1x notional per flip; avg% = mean net return per flip;'
  );
  console.log('PF on net PnL. Compare the scheduled mean against both 24h baselines to see if the schedule adds anything.\n');
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
