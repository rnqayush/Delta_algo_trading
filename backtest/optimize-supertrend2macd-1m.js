// Parameter optimizer for the "Super Trend 2 MACD" port (see
// research-supertrend2macd-1m.js). Grid-searches the strategy's own knobs and
// reports the configs that make the most money — plus an honest read on whether
// that money is real or curve-fit.
//
//   node backtest/optimize-supertrend2macd-1m.js
//   node backtest/optimize-supertrend2macd-1m.js --top 25 --symbol BTCUSD
//
// Anti-overfit design:
//   * the 30-day cache is split into 3 contiguous blocks; a config is only
//     labelled ROBUST when it is net-positive in ALL THREE blocks (that is the
//     closest thing to out-of-sample we can get with 30 days of 1m data).
//   * the last-7-days window is reported separately so you can see whether the
//     winner's edge survives on the window you actually asked about.
//   * a minimum trade count is enforced so 5-lucky-trades configs do not top
//     the table.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadCache, DATA_DIR } = require('./lib/data');
const {
  P: BASE,
  CFG,
  buildSignals,
  simulate,
  metrics,
  lastNDays,
  f2,
  pct,
} = require('./research-supertrend2macd-1m');

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

const GRID = {
  factor: [1, 2, 3, 4, 5],
  pd: [1, 3, 7, 14, 21, 30],
  htfSec: [3600, 7200, 14400, 28800],
  htfFactor: [2, 3],
  htfPd: [1, 7, 14],
  macd: [null, [12, 26, 9], [5, 13, 1]],
  exit: [
    { exitMode: 'bracket', tpPoints: 500, slPoints: 400 },
    { exitMode: 'bracket', tpPoints: 300, slPoints: 200 },
    { exitMode: 'bracket', tpPoints: 200, slPoints: 100 },
    { exitMode: 'bracket', tpPoints: 150, slPoints: 150 },
    { exitMode: 'bracket', tpPoints: 100, slPoints: 200 },
    { exitMode: 'bracket', tpPoints: 600, slPoints: 150 },
    { exitMode: 'bracket', tpPoints: 1000, slPoints: 200 },
    { exitMode: 'bracket', tpPoints: 400, slPoints: 100 },
    { exitMode: 'trail', tpPoints: 0, slPoints: 400 },
    { exitMode: 'trail', tpPoints: 0, slPoints: 800 },
  ],
  mode: ['reverse', 'hold'],
};

const MIN_TRADES_30D = 30; // ignore configs that barely trade
const MIN_TRADES_ANY = 10; // floor for the "absolute best" line

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dayKeys(candles) {
  const set = new Set();
  for (const c of candles) set.add(new Date(c.time * 1000).toISOString().slice(0, 10));
  return [...set].sort();
}

function splitBlocks(days, n) {
  const out = [];
  const size = Math.ceil(days.length / n);
  for (let i = 0; i < days.length; i += size) out.push(new Set(days.slice(i, i + size)));
  return out;
}

const filterDays = (trades, set) => trades.filter((t) => set.has(t.day));

function scoreOf(trades) {
  const m = metrics(trades);
  const pnlPct = (m.net / CFG.initialEquity) * 100;
  return { ...m, pnlPct };
}

const exitTag = (e) => (e.exitMode === 'trail' ? 'trail' : `tp${e.tpPoints}/sl${e.slPoints}`);
const macdTag = (m) => (m == null ? 'off' : `${m[0]}/${m[1]}/${m[2]}`);
const htfTag = (sec) => `${sec / 3600}h`;

function paramTag(cfg) {
  return [
    `st=${cfg.factor}/${cfg.pd}`,
    `main=${htfTag(cfg.htfSec)} ${cfg.htfFactor}/${cfg.htfPd}`,
    `macd=${macdTag(cfg.macd)}`,
    exitTag(cfg.exit),
    cfg.mode,
  ].join('  ');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { top: 20, symbol: 'BTCUSD', maker: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--top') a.top = Number(argv[++i]);
    else if (argv[i] === '--symbol') a.symbol = String(argv[++i]);
    else if (argv[i] === '--maker') a.maker = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  const cached = loadCache(args.symbol, '1m');
  if (!cached || !cached.candles) throw new Error(`No ${args.symbol} 1m cache. Run backtest/fetch.js first.`);
  const candles = cached.candles;

  const days = dayKeys(candles);
  const blocks = splitBlocks(days, 3);
  const last7 = new Set(days.slice(-7));
  const first = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
  const last = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);

  console.log('============================================================');
  console.log(' Optimizing "Super Trend 2 MACD" — BTCUSD 1m');
  console.log(` data ${first} -> ${last}  (${candles.length} bars, ${days.length} days)`);
  console.log(
    ` blocks  ${blocks.map((b, i) => `B${i + 1}=${[...b].length}d`).join('  ')}   ` +
      `last-7-days = ${[...last7][0]} .. ${[...last7].slice(-1)[0]}`,
  );
  console.log(
    ` grid    factor ${GRID.factor.length} x pd ${GRID.pd.length} x htf ${GRID.htfSec.length} x ` +
      `mainST ${GRID.htfFactor.length}x${GRID.htfPd.length} x macd ${GRID.macd.length} x ` +
      `exit ${GRID.exit.length} x mode ${GRID.mode.length}`,
  );
  console.log(
    ` costs   ${args.maker ? `MAKER entry ${(CFG.feeMaker * 1e4).toFixed(1)}bps + maker TP ${(CFG.feeMaker * 1e4).toFixed(1)}bps, market stop ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps` : `TAKER entry ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps, market stop taker+slip, target taker`}`,
  );
  console.log('============================================================');

  const results = [];
  let sims = 0;
  const t0 = Date.now();

  for (const factor of GRID.factor) {
    for (const pd of GRID.pd) {
      for (const htfSec of GRID.htfSec) {
        for (const htfFactor of GRID.htfFactor) {
          for (const htfPd of GRID.htfPd) {
            for (const macd of GRID.macd) {
              const p = {
                ...BASE,
                factor,
                pd,
                htfSec,
                htfFactor,
                htfPd,
                makerEntry: args.maker,
                useMacd: macd != null,
                macdFast: macd ? macd[0] : BASE.macdFast,
                macdSlow: macd ? macd[1] : BASE.macdSlow,
                macdSignal: macd ? macd[2] : BASE.macdSignal,
              };
              const built = buildSignals(candles, p);

              for (const exit of GRID.exit) {
                for (const mode of GRID.mode) {
                  const pp = { ...p, ...exit };
                  const trades = simulate(candles, built, mode, pp);
                  sims += 1;
                  const m = scoreOf(trades);
                  if (m.n < MIN_TRADES_ANY) continue;
                  const b = blocks.map((blk) => scoreOf(filterDays(trades, blk)).net);
                  const d7 = scoreOf(filterDays(trades, last7));
                  results.push({
                    cfg: { factor, pd, htfSec, htfFactor, htfPd, macd, exit, mode },
                    m,
                    blocks: b,
                    d7,
                    robust: b.every((x) => x > 0),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n${sims} simulations in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${results.length} passed the trade filter`);

  // ---- baseline (the published config) -------------------------------------
  const baseBuilt = buildSignals(candles, BASE);
  for (const mode of ['reverse', 'hold']) {
    const t = simulate(candles, baseBuilt, mode, BASE);
    const m = scoreOf(t);
    const d7 = scoreOf(filterDays(t, last7));
    console.log(
      `baseline ${mode.padEnd(8)} st=1/1 main=2h 1/1 macd=12/26/9 tp500/sl400  ` +
        `30d: trades ${m.n} net ${f2(m.net)} (${f2(m.pnlPct)}%)  7d: net ${f2(d7.net)} (${f2(d7.pnlPct)}%)`,
    );
  }

  // ---- ranking -------------------------------------------------------------
  const tradable = results.filter((r) => r.m.n >= MIN_TRADES_30D);
  const byNet = [...tradable].sort((a, b) => b.m.net - a.m.net);
  const robust = byNet.filter((r) => r.robust);

  // The single best net-P&L config anywhere in the grid, trade floor relaxed —
  // this is the ceiling the strategy can reach even before we worry about
  // robustness.
  const absBest = [...results].sort((a, b) => b.m.net - a.m.net)[0];
  const absBestR = [...results].sort((a, b) => b.m.netR - a.m.netR)[0];
  const costPerTradeR = results.length ? results.reduce((s, r) => s + r.m.netR - r.m.grossR, 0) / results.length : 0;
  console.log(
    `\naverage round-trip cost = ${Math.abs(costPerTradeR).toFixed(3)} R per trade — a config needs a gross edge above that to survive`,
  );
  if (absBest) {
    console.log(
      `absolute best 30d net : ${paramTag(absBest.cfg)}  ->  net ${f2(absBest.m.net)} (${f2(absBest.m.pnlPct)}%)  ` +
        `trades ${absBest.m.n}  grossR ${f2(absBest.m.grossR)}  netR ${f2(absBest.m.netR)}`,
    );
  }
  if (absBestR) {
    console.log(
      `absolute best 30d netR: ${paramTag(absBestR.cfg)}  ->  netR ${f2(absBestR.m.netR)}  grossR ${f2(absBestR.m.grossR)}  ` +
        `net ${f2(absBestR.m.net)} (${f2(absBestR.m.pnlPct)}%)  trades ${absBestR.m.n}`,
    );
  }

  console.log(`\n################  TOP ${args.top} BY 30-DAY NET P&L (after costs, >=${MIN_TRADES_30D} trades)  ################`);
  console.log(
    '  #  params'.padEnd(72) + '  trades  win%   grossR   netR   net$(30d)  pct%   net$(7d)  pct7%   B1/B2/B3     PF',
  );
  byNet.slice(0, args.top).forEach((r, i) => {
    const c = r.cfg;
    console.log(
      `  ${String(i + 1).padStart(2)}  ${paramTag(c).padEnd(68)}  ` +
        `${String(r.m.n).padStart(5)}  ${pct(r.m.winPct).padStart(5)}  ` +
        `${f2(r.m.grossR).padStart(6)}  ${f2(r.m.netR).padStart(5)}  ${f2(r.m.net).padStart(9)}  ` +
        `${f2(r.m.pnlPct).padStart(5)}  ${f2(r.d7.net).padStart(8)}  ${f2(r.d7.pnlPct).padStart(5)}  ` +
        `${r.blocks.map((x) => f2(x).padStart(7)).join('')}  ` +
        `${(r.m.pf === Infinity ? 'inf' : r.m.pf.toFixed(2)).padStart(5)}`,
    );
  });

  console.log(`\n################  ROBUST (net-positive in all 3 blocks)  ################`);
  if (!robust.length) {
    console.log('  none — no configuration is net-positive across all three blocks after costs.');
  } else {
    robust.slice(0, args.top).forEach((r, i) => {
      const c = r.cfg;
      console.log(
        `  ${String(i + 1).padStart(2)}  ${paramTag(c).padEnd(68)}  ` +
          `30d net ${f2(r.m.net).padStart(9)} (${f2(r.m.pnlPct)}%)  trades ${String(r.m.n).padStart(4)}  ` +
          `7d net ${f2(r.d7.net).padStart(8)}  blocks ${r.blocks.map((x) => f2(x)).join(' / ')}`,
      );
    });
  }

  // ---- best gross (zero-cost) config, for the "pure edge" question ----------
  const byGross = [...results].sort((a, b) => b.m.gross - a.m.gross);
  console.log(`\n################  TOP 5 BY GROSS (zero-cost, "pure edge")  ################`);
  byGross.slice(0, 5).forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${paramTag(r.cfg).padEnd(68)}  ` +
        `gross ${f2(r.m.gross).padStart(9)}  net ${f2(r.m.net).padStart(9)}  ` +
        `grossR ${f2(r.m.grossR)}  trades ${String(r.m.n).padStart(4)}`,
    );
  });

  const outFile = path.join(DATA_DIR, `optimize-supertrend2macd-${args.symbol}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: args.symbol,
        sims,
        baseline: BASE,
        top: byNet.slice(0, 200).map((r) => ({
          cfg: { ...r.cfg, macd: r.cfg.macd === null ? 'off' : r.cfg.macd.join('/') },
          net30d: round(r.m.net),
          pct30d: round(r.m.pnlPct),
          trades: r.m.n,
          winPct: round(r.m.winPct),
          grossR: round(r.m.grossR),
          netR: round(r.m.netR),
          blocks: r.blocks.map(round),
          net7d: round(r.d7.net),
          pct7d: round(r.d7.pnlPct),
          robust: r.robust,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nfull ranking -> ${outFile}\n`);
}

const round = (v) => Math.round(v * 100) / 100;

main();
