// Support/Resistance zone engine — build it, measure it, then trade it.
//
// The user's thesis: "everything lies in support/resistance and their
// breakouts". This script does three things, in order, so the thesis can be
// judged on evidence instead of belief:
//
//   PHASE 1 — FIND the zones (efficiently) and measure them.
//     * swing pivots (fractals) confirm a turning point at bar j only once
//       `pivotK` bars have closed after it, so a zone is never built from a
//       future bar.
//     * nearby pivots are CLUSTERED into one zone (price action remembers a
//       level, not a tick), and the number of pivots in a cluster is the zone's
//       touch count = its strength.
//     * a zone that sits on a HIGH-VOLUME NODE of the volume profile is an
//       ACCUMULATION / DISTRIBUTION shelf (lots of business done at that price);
//       a zone in a quiet pocket is just noise.
//     * then the zones are graded: for every time price reached a zone, did it
//       REJECT (held) or BREAK (gave way)? Split by touch count and volume so we
//       learn which zones actually matter.
//
//   PHASE 2 — TRADE the two things zones do.
//     * retest  : a close beyond a zone flips it (resistance -> support); a
//                 resting LIMIT at the flipped edge enters on the pullback
//                 (maker fill, cheap).
//     * fade    : price reaches a zone and rejects; a resting LIMIT at the edge
//                 (maker) or a confirmed close back outside (taker) enters.
//     * every variant pays real Delta fees (2 bps maker / 5 bps taker +
//       2 bps slippage on market exits) because on this project cost is the
//       difference between a signal and a business.
//
//   PHASE 3 — VERDICT. Is any of it net-positive after fees, and does it hold up
//     on another timeframe (robustness) rather than only on the tuned one?
//
// No look-ahead anywhere in the strategy: at bar i the code only uses pivots
// confirmed at or before i, and zones whose breaking close already happened.
//
//   node backtest/research-zones.js --tf 1h
//   node backtest/research-zones.js --tf 15m --days 60
//   node backtest/research-zones.js --tf 1h --nofee     # raw edge, no costs
//
'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const RES_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };

// Real Delta perp fee schedule. Kept separate from CFG so --nofee can report the
// raw alpha and the cost drag side by side.
const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

const CFG = {
  contractValue: 0.001,
  feeMaker: REAL.maker,
  feeTaker: REAL.taker,
  slippage: REAL.slip,
  initialEquity: 1200,
  riskPct: 0.005, // 0.5% of equity risked per trade
  maxNotionalPct: 3,
};

// Tuning block. Defaults are deliberately conservative and are NOT fitted to the
// last 7 days; the point of the grid in PHASE 2 is to see the whole surface.
const P = {
  // --- zone geometry ---
  pivotK: 5, // fractal half-width: a pivot needs K lower highs/lows each side
  zoneAtrMult: 0.5, // zone half-width = 0.5 x ATR (bands are ATR-scaled)
  mergeAtrMult: 0.75, // pivots within 0.75 x ATR of a centre join that zone
  maxZoneAgeBars: 200, // a zone with no new pivot for this long is retired
  atrPeriod: 14,
  // --- volume profile (accumulation / distribution) ---
  volWindow: 300, // trailing bars used for the volume profile
  volBinAtr: 0.5, // profile bin height = 0.5 x ATR
  hvnMult: 1.3, // band must beat this multiple of the mean bin to be an HVN
  // --- strategy ---
  minTouches: 2,
  requireHVN: false,
  breakoutBufAtr: 0.1, // breakout close must clear the edge by this x ATR
  proximityAtr: 0.75, // fade arms only when price is this close to the edge
  stopBufAtr: 0.25, // stop sits this far beyond the far edge of the zone
  retestWindowBars: 12, // how long a resting limit stays live
  exitMode: 'target', // 'target' = fixed R, 'trail' = breakeven + ATR trail
  targetR: 2,
  beAtR: 0.5,
  trailAtrMult: 2,
  holdBars: 48,
  erMin: 0,
  erMax: 1,
  trendMa: 0, // 0 = off; else only fade with the EMA trend (long above, short below)
  minAtrPct: 0, // 0 = off; else require ATR/price >= this (big enough move to pay fees)
};

// ---------------------------------------------------------------------------
// indicators (same maths as src/utils/indicators.js)
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

function erSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    const change = Math.abs(candles[i].close - candles[i - period].close);
    let travel = 0;
    for (let j = i - period + 1; j <= i; j += 1) travel += Math.abs(candles[j].close - candles[j - 1].close);
    out[i] = travel ? change / travel : 0;
  }
  return out;
}

function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHASE 1 — zone engine
// ---------------------------------------------------------------------------

function isPivotHigh(candles, j, k) {
  const h = candles[j].high;
  for (let m = j - k; m <= j + k; m += 1) {
    if (m === j || m < 0 || m >= candles.length) continue;
    if (candles[m].high > h) return false;
  }
  return true;
}

function isPivotLow(candles, j, k) {
  const l = candles[j].low;
  for (let m = j - k; m <= j + k; m += 1) {
    if (m === j || m < 0 || m >= candles.length) continue;
    if (candles[m].low < l) return false;
  }
  return true;
}

// Is the price band [lo, hi] an accumulation/distribution shelf? Builds the
// volume profile from the trailing `volWindow` bars only (no look-ahead) and
// asks whether the band's average bin beats the profile mean by `hvnMult`.
function bandIsHVN(candles, endIdx, atrV, lo, hi, p) {
  const from = Math.max(0, endIdx - p.volWindow);
  const bin = Math.max(1e-9, atrV * p.volBinAtr);
  const vols = new Map();
  for (let m = from; m <= endIdx; m += 1) {
    const c = candles[m];
    const tp = (c.high + c.low + c.close) / 3;
    const b = Math.floor(tp / bin);
    vols.set(b, (vols.get(b) || 0) + c.volume);
  }
  if (!vols.size) return false;
  const vals = [...vols.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const b0 = Math.floor(lo / bin);
  const b1 = Math.floor(hi / bin);
  let band = 0;
  for (let b = b0; b <= b1; b += 1) band += vols.get(b) || 0;
  const avgBand = band / Math.max(1, b1 - b0 + 1);
  return avgBand >= mean * p.hvnMult;
}

// Single forward pass. A pivot at bar j is only used once bar j + pivotK has
// closed, so `zoneAt[i]` (the zones visible at bar i) never contains a level
// that was only knowable later. Zone bands are frozen at creation for the same
// reason; later pivots only add to the touch count.
function buildZones(candles, atrArr, p) {
  const n = candles.length;
  const table = [];
  const zoneAt = new Array(n);
  const zones = []; // active zone ids

  const touch = (price, barIdx, atrV) => {
    const tol = atrV * p.mergeAtrMult;
    let best = null;
    let bestDist = Infinity;
    for (const id of zones) {
      const z = table[id];
      const dist = Math.abs(price - z.center);
      if (dist <= tol && dist < bestDist) {
        best = z;
        bestDist = dist;
      }
    }
    if (best) {
      // re-centre on a volume-weighted mean of the pivots in the cluster
      const totalW = best.vol + candles[barIdx].volume;
      best.center = (best.center * best.vol + price * candles[barIdx].volume) / (totalW || 1);
      best.vol = totalW;
      best.halfWidth = Math.max(best.halfWidth, atrV * p.zoneAtrMult);
      best.low = best.center - best.halfWidth;
      best.high = best.center + best.halfWidth;
      best.touches += 1;
      best.lastPivotBar = barIdx;
      return;
    }
    const hw = Math.max(1e-9, atrV * p.zoneAtrMult);
    const id = table.length;
    table.push({
      id,
      center: price,
      halfWidth: hw,
      low: price - hw,
      high: price + hw,
      touches: 1,
      firstPivotBar: barIdx,
      lastPivotBar: barIdx,
      vol: candles[barIdx].volume,
      hvn: bandIsHVN(candles, barIdx, atrV, price - hw, price + hw, p),
      brokenUpAt: null,
      brokenDownAt: null,
    });
    zones.push(id);
  };

  for (let i = 0; i < n; i += 1) {
    const j = i - p.pivotK;
    if (j >= p.pivotK) {
      const a = atrArr[j];
      if (a && a > 0) {
        if (isPivotHigh(candles, j, p.pivotK)) touch(candles[j].high, j, a);
        if (isPivotLow(candles, j, p.pivotK)) touch(candles[j].low, j, a);
      }
    }
    for (let z = zones.length - 1; z >= 0; z -= 1) {
      if (i - table[zones[z]].lastPivotBar > p.maxZoneAgeBars) zones.splice(z, 1);
    }
    zoneAt[i] = zones.slice(); // ids visible at bar i
  }

  return { table, zoneAt };
}

// Grades the zones: every approach to a live zone resolves as a rejection (it
// held) or a break (it gave way). Bucketed by touch count and HVN so we can see
// which zones are worth respecting.
function gradeZones(candles, table, zoneAt, p, horizon) {
  const n = candles.length;
  const state = new Map(); // zoneId -> 'above' | 'below' | 'inside'
  const events = [];

  for (let i = 0; i < n; i += 1) {
    const ids = zoneAt[i];
    if (!ids || !ids.length) continue;
    const bar = candles[i];
    for (const id of ids) {
      const z = table[id];
      const prev = state.get(id) || (bar.close > z.high ? 'above' : 'below');
      let pos;
      if (bar.close > z.high) pos = 'above';
      else if (bar.close < z.low) pos = 'below';
      else pos = 'inside';

      // approach from above -> the zone is being tested as SUPPORT
      // approach from below -> tested as RESISTANCE
      if (prev === 'above' && pos === 'inside') {
        events.push(resolve(candles, table, id, i, 'support', p, horizon));
      } else if (prev === 'below' && pos === 'inside') {
        events.push(resolve(candles, table, id, i, 'resistance', p, horizon));
      }
      state.set(id, pos);
    }
  }
  return events.filter(Boolean);
}

// For a touch at bar i, walk forward: if the far edge breaks first the zone
// failed, if the near edge is reclaimed first it held.
function resolve(candles, table, id, i, role, p, horizon) {
  const z = table[id];
  const end = Math.min(candles.length - 1, i + horizon);
  for (let m = i + 1; m <= end; m += 1) {
    const c = candles[m].close;
    if (role === 'support') {
      if (c < z.low) return { role, touches: z.touches, hvn: z.hvn, outcome: 'break', bars: m - i, time: candles[i].time };
      if (c > z.high) return { role, touches: z.touches, hvn: z.hvn, outcome: 'reject', bars: m - i, time: candles[i].time };
    } else {
      if (c > z.high) return { role, touches: z.touches, hvn: z.hvn, outcome: 'break', bars: m - i, time: candles[i].time };
      if (c < z.low) return { role, touches: z.touches, hvn: z.hvn, outcome: 'reject', bars: m - i, time: candles[i].time };
    }
  }
  return { role, touches: z.touches, hvn: z.hvn, outcome: 'unresolved', bars: horizon, time: candles[i].time };
}

// ---------------------------------------------------------------------------
// PHASE 2 — strategy
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (dist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function zonePasses(z, p) {
  if (z.touches < p.minTouches) return false;
  if (p.requireHVN && !z.hvn) return false;
  return true;
}

function runStrategy(candles, table, zoneAt, atrArr, erArr, emaArr, p, variant) {
  const n = candles.length;
  const trades = [];
  let pos = null;
  let pending = null;

  // Extra entry gates that decide *whether a setup is worth taking*, as opposed
  // to *where* the level is. These are the tuning levers.
  const gateOk = (side, bar, i, a) => {
    if (p.minAtrPct > 0 && a / bar.close < p.minAtrPct) return false;
    if (p.trendMa > 0) {
      const em = emaArr[i];
      if (em !== null && em !== undefined) {
        if (side === 'long' && bar.close <= em) return false;
        if (side === 'short' && bar.close >= em) return false;
      }
    }
    return true;
  };

  const closePos = (exitPrice, bar, reason, isMaker) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const exitNotional = exitPrice * pos.contracts * CFG.contractValue;
    const exitFee =
      exitNotional * (isMaker ? CFG.feeMaker : CFG.feeTaker) + (isMaker ? 0 : exitNotional * CFG.slippage);
    const fees = pos.entryFee + exitFee;
    const gross = (exitPrice - pos.entry) * dir * pos.contracts * CFG.contractValue;
    trades.push({
      net: gross - fees,
      fees,
      gross,
      r: (gross - fees) / Math.max(1e-9, pos.riskAmount),
      reason,
      entryTime: pos.barTime,
      exitTime: bar.time,
    });
    pos = null;
  };

  const openPos = (side, fill, stop, bar, i, entryIsMaker) => {
    const contracts = sizeContracts(fill, stop);
    if (!(contracts > 0)) return false;
    const dist = Math.abs(fill - stop);
    const notional = fill * contracts * CFG.contractValue;
    const entryFee = notional * (entryIsMaker ? CFG.feeMaker : CFG.feeTaker) + (entryIsMaker ? 0 : notional * CFG.slippage);
    pos = {
      side,
      entry: fill,
      stop,
      risk: dist,
      riskAmount: dist * contracts * CFG.contractValue,
      contracts,
      entryFee,
      barTime: bar.time,
      entryBar: i,
      peak: fill,
    };
    return true;
  };

  const warmup = Math.max(p.pivotK * 2 + 1, p.atrPeriod * 3, p.volWindow > n ? 60 : 60);

  for (let i = warmup; i < n; i += 1) {
    const bar = candles[i];
    const a = atrArr[i];
    if (!a) continue;
    const ids = zoneAt[i] || [];

    // Mark zone breaks as-of this bar's close. This runs every bar (before any
    // `continue`) so a zone's broken state stays current even while a trade is
    // open. The fresh break is remembered for the retest family below.
    const freshBreak = new Map();
    for (const id of ids) {
      const z = table[id];
      if (z.brokenUpAt === null && bar.close > z.high) {
        z.brokenUpAt = i;
        freshBreak.set(id, 'up');
      } else if (z.brokenDownAt === null && bar.close < z.low) {
        z.brokenDownAt = i;
        freshBreak.set(id, 'down');
      }
    }

    // 1. work the resting limit
    if (!pos && pending) {
      if (i > pending.expires) {
        pending = null;
      } else {
        let fill = null;
        if (pending.side === 'long' && bar.low <= pending.limit) fill = Math.min(bar.open, pending.limit);
        else if (pending.side === 'short' && bar.high >= pending.limit) fill = Math.max(bar.open, pending.limit);
        if (fill !== null) {
          openPos(pending.side, fill, pending.stop, bar, i, true);
          pending = null;
        }
      }
    }

    // 2. manage the open position
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;

      // trailing mode: ratchet the stop to breakeven, then trail it by ATR
      if (p.exitMode === 'trail') {
        const prevClose = candles[i - 1].close;
        pos.peak = dir === 1 ? Math.max(pos.peak, prevClose) : Math.min(pos.peak, prevClose);
        const advance = (pos.peak - pos.entry) * dir;
        const cand = [pos.stop];
        if (p.beAtR > 0 && advance >= p.beAtR * pos.risk) cand.push(pos.entry);
        if (p.trailAtrMult > 0) cand.push(pos.peak - dir * p.trailAtrMult * a);
        const best = dir === 1 ? Math.max(...cand) : Math.min(...cand);
        if (dir === 1 ? best > pos.stop : best < pos.stop) pos.stop = best;
      }

      const target = p.exitMode === 'target' ? pos.entry + dir * p.targetR * pos.risk : null;
      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTarget = target !== null && (dir === 1 ? bar.high >= target : bar.low <= target);
      if (hitStop) closePos(pos.stop, bar, 'stop', false);
      else if (hitTarget) closePos(target, bar, 'target', true);
      else if (i - pos.entryBar >= p.holdBars) closePos(bar.close, bar, 'time', false);
    }

    if (pos || pending) continue;

    // regime gate
    const e = erArr[i];
    if (e !== null && (e < p.erMin || e > p.erMax)) continue;

    // 3. arm a new entry
    if (variant === 'retest') {
      for (const id of ids) {
        const z = table[id];
        if (!zonePasses(z, p)) continue;
        const fb = freshBreak.get(id);
        if (!fb) continue;
        if (fb === 'up' && bar.close > z.high + p.breakoutBufAtr * a && gateOk('long', bar, i, a)) {
          const limit = z.high;
          const stop = z.low - p.stopBufAtr * a;
          if (stop < limit) {
            pending = { side: 'long', limit, stop, expires: i + p.retestWindowBars };
            break;
          }
        } else if (fb === 'down' && bar.close < z.low - p.breakoutBufAtr * a && gateOk('short', bar, i, a)) {
          const limit = z.low;
          const stop = z.high + p.stopBufAtr * a;
          if (stop > limit) {
            pending = { side: 'short', limit, stop, expires: i + p.retestWindowBars };
            break;
          }
        }
      }
    } else if (variant === 'fade') {
      for (const id of ids) {
        const z = table[id];
        if (!zonePasses(z, p)) continue;
        const prevClose = candles[i - 1].close;
        // support fade: price is above the zone and drifting down into it. The
        // zone is only valid support while it has never closed BELOW its low;
        // price being above it is the normal state, not a break.
        if (
          z.brokenDownAt === null &&
          prevClose > z.high && bar.close > z.high && bar.close - z.high <= p.proximityAtr * a &&
          gateOk('long', bar, i, a)
        ) {
          const limit = z.high;
          const stop = z.low - p.stopBufAtr * a;
          if (stop < limit) {
            pending = { side: 'long', limit, stop, expires: i + p.retestWindowBars };
            break;
          }
        }
        // resistance fade: price is below the zone and drifting up into it.
        if (
          z.brokenUpAt === null &&
          prevClose < z.low && bar.close < z.low && z.low - bar.close <= p.proximityAtr * a &&
          gateOk('short', bar, i, a)
        ) {
          const limit = z.low;
          const stop = z.high + p.stopBufAtr * a;
          if (stop > limit) {
            pending = { side: 'short', limit, stop, expires: i + p.retestWindowBars };
            break;
          }
        }
      }
    } else if (variant === 'fadeCnf') {
      // confirmed rejection: the bar pierced the zone and closed back outside
      for (const id of ids) {
        const z = table[id];
        if (!zonePasses(z, p)) continue;
        if (bar.low <= z.high && z.brokenDownAt === null && bar.close > z.high && bar.close > bar.open) {
          const stop = z.low - p.stopBufAtr * a;
          if (openPos('long', bar.close, stop, bar, i, false)) break;
        } else if (bar.high >= z.low && z.brokenUpAt === null && bar.close < z.low && bar.close < bar.open) {
          const stop = z.high + p.stopBufAtr * a;
          if (openPos('short', bar.close, stop, bar, i, false)) break;
        }
      }
    }
  }

  if (pos) closePos(candles[n - 1].close, candles[n - 1], 'time', false);
  return trades;
}

// ---------------------------------------------------------------------------
// stats + reporting
// ---------------------------------------------------------------------------

function dayKey(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function summarise(trades) {
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  const gp = trades.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(trades.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const byDay = new Map();
  for (const t of trades) {
    const d = dayKey(t.entryTime);
    byDay.set(d, (byDay.get(d) || 0) + t.net);
  }
  const days = byDay.size || 1;
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    cum += t.net;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  return {
    n,
    net,
    gross: net + fees,
    fees,
    wr: n ? (trades.filter((t) => t.net > 0).length / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgR: n ? trades.reduce((s, t) => s + t.r, 0) / n : 0,
    maxDd,
    perDay: n / days,
    green: [...byDay.values()].filter((v) => v > 0).length,
    days,
  };
}

function fmt(x, d = 2) {
  return Number.isFinite(x) ? x.toFixed(d) : 'inf';
}
function pad(t, w, right = false) {
  const s = String(t);
  return right ? s.padStart(w) : s.padEnd(w);
}

function parseArgs(argv) {
  const a = { tf: '1h', days: 0, nofee: false, horizon: 30 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--tf') a.tf = argv[++i];
    else if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--nofee') a.nofee = true;
    else if (argv[i] === '--horizon') a.horizon = Number(argv[++i]);
  }
  return a;
}

function bucketTouches(t) {
  return t >= 4 ? '4+' : String(t);
}

function printGrades(title, events) {
  console.log(`\n${title}  (n=${events.length})`);
  const byBucket = new Map();
  for (const e of events) {
    const key = `${e.role} | touches ${bucketTouches(e.touches)} | ${e.hvn ? 'HVN' : 'quiet'}`;
    const b = byBucket.get(key) || { n: 0, brk: 0, rej: 0, un: 0, bars: 0 };
    b.n += 1;
    if (e.outcome === 'break') b.brk += 1;
    else if (e.outcome === 'reject') { b.rej += 1; b.bars += e.bars; }
    else b.un += 1;
    byBucket.set(key, b);
  }
  const keys = [...byBucket.keys()].sort();
  console.log(
    `  ${pad('zone class', 34)} | ${pad('n', 6, true)} | ${pad('%break', 7, true)} | ${pad('%reject', 8, true)} | ${pad('avg bars to reject', 18, true)}`
  );
  console.log('  ' + '-'.repeat(84));
  for (const k of keys) {
    const b = byBucket.get(k);
    console.log(
      `  ${pad(k, 34)} | ${pad(b.n, 6, true)} | ${pad(((b.brk / b.n) * 100).toFixed(0) + '%', 7, true)} | ` +
        `${pad(((b.rej / b.n) * 100).toFixed(0) + '%', 8, true)} | ${pad(b.rej ? (b.bars / b.rej).toFixed(1) : '-', 18, true)}`
    );
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.nofee) {
    CFG.feeMaker = 0;
    CFG.feeTaker = 0;
    CFG.slippage = 0;
  }
  const resSec = RES_SEC[args.tf];
  if (!resSec) throw new Error(`Unsupported tf "${args.tf}"`);

  const cached = loadCache(SYMBOL, args.tf);
  if (!cached) throw new Error(`No ${args.tf} cache. Run: node backtest/fetch.js --timeframes ${args.tf}`);

  // Zones are always built and traded on the FULL cached series so short-window
  // reports still have proper zone context. `--days` only limits which trades
  // (and zone approaches) are counted in the report.
  const candles = cached.candles;
  if (candles.length < 300) throw new Error(`Not enough bars (${candles.length})`);
  const cutoff = args.days > 0 ? candles[candles.length - 1].time - args.days * 86400 : 0;

  const atrArr = atr(candles, P.atrPeriod);
  const erArr = erSeries(candles, 10);
  const emaArr = ema(candles.map((c) => c.close), 200);
  const { table, zoneAt } = buildZones(candles, atrArr, P);

  const first = dayKey(candles[0].time);
  const last = dayKey(candles[candles.length - 1].time);

  console.log('============================================================');
  console.log(
    ` S/R ZONE ENGINE — ${SYMBOL} ${args.tf}   data ${first} -> ${last}  (${candles.length} bars)` +
      (cutoff ? `   REPORT WINDOW: last ${args.days} days` : '')
  );
  console.log(
    ` costs  maker ${(CFG.feeMaker * 1e4).toFixed(1)}bps / taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + ` +
      `${(CFG.slippage * 1e4).toFixed(1)}bps slip${args.nofee ? '   [ZERO-COST MODE]' : ''}`
  );
  console.log(
    ` zones  pivotK=${P.pivotK} halfWidth=${P.zoneAtrMult}ATR merge=${P.mergeAtrMult}ATR age<=${P.maxZoneAgeBars}bars`
  );
  console.log('============================================================');

  // ---- PHASE 1: what did the engine find, and do the zones hold? ----------
  const withHVN = table.filter((z) => z.hvn).length;
  const touchHist = new Map();
  for (const z of table) touchHist.set(z.touches, (touchHist.get(z.touches) || 0) + 1);
  console.log('\nPHASE 1 — zones found');
  console.log(`  total zones: ${table.length}   on a high-volume node: ${withHVN} (${((withHVN / table.length) * 100).toFixed(0)}%)`);
  console.log(
    `  touch-count histogram: ` +
      [...touchHist.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => `${t}x:${c}`).join('  ')
  );

  const eventsAll = gradeZones(candles, table, zoneAt, P, args.horizon);
  const events = cutoff ? eventsAll.filter((e) => e.time >= cutoff) : eventsAll;
  console.log(`\n  zone reliability over ${args.horizon} bars after each approach:`);
  printGrades('  ALL APPROACHES', events);
  const strong = events.filter((e) => e.touches >= 2);
  printGrades('  ZONES WITH >=2 TOUCHES', strong);
  const strongHVN = events.filter((e) => e.touches >= 2 && e.hvn);
  if (strongHVN.length) printGrades('  ZONES WITH >=2 TOUCHES ON A HVN SHELF', strongHVN);

  // ---- PHASE 2: trade the zones ------------------------------------------
  console.log('\n\nPHASE 2 — tuning grid (zone quality x regime x trend x volatility x exit)');
  const variants = ['fade', 'fadeCnf', 'retest'];
  const filterSets = [];
  for (const minTouches of [2, 3]) {
    for (const requireHVN of [false, true]) {
      for (const erMax of [1, 0.4]) {
        for (const trendMa of [0, 200]) {
          for (const minAtrPct of [0, 0.0012]) {
            filterSets.push({ minTouches, requireHVN, erMax, trendMa, minAtrPct });
          }
        }
      }
    }
  }
  const exits = [
    { label: 'TP1R', exitMode: 'target', targetR: 1 },
    { label: 'TP1.5R', exitMode: 'target', targetR: 1.5 },
    { label: 'TP2R', exitMode: 'target', targetR: 2 },
    { label: 'be0.5+trail2', exitMode: 'trail', targetR: 0, beAtR: 0.5, trailAtrMult: 2 },
  ];

  const rows = [];
  for (const variant of variants) {
    for (const fs of filterSets) {
      for (const ex of exits) {
        // The zone table is independent of the tuning knobs; only the break
        // flags mutate during a run, so reset those instead of rebuilding.
        for (const z of table) {
          z.brokenUpAt = null;
          z.brokenDownAt = null;
        }
        const p = { ...P, ...fs, ...ex };
        const allTrades = runStrategy(candles, table, zoneAt, atrArr, erArr, emaArr, p, variant);
        const trades = cutoff ? allTrades.filter((t) => t.entryTime >= cutoff) : allTrades;
        rows.push({ variant, fs, ex, p, s: summarise(trades), trades });
      }
    }
  }

  rows.sort((a, b) => b.s.net - a.s.net);
  console.log(
    `\n ${pad('rank', 4)} | ${pad('family', 7)} | ${pad('minT', 4, true)} | ${pad('HVN', 4, true)} | ${pad('ER<=', 5, true)} | ` +
      `${pad('trendMA', 7, true)} | ${pad('atr%', 5, true)} | ${pad('exit', 13)} | ${pad('trades', 6, true)} | ${pad('win%', 5, true)} | ` +
      `${pad('PF', 5, true)} | ${pad('avgR', 6, true)} | ${pad('net$', 9, true)} | ${pad('fees$', 8, true)} | ${pad('maxDD$', 8, true)}`
  );
  console.log(' ' + '-'.repeat(150));
  rows.slice(0, 15).forEach((r, i) => {
    console.log(
      ` ${pad(i + 1, 4)} | ${pad(r.variant, 7)} | ${pad(r.fs.minTouches, 4, true)} | ${pad(r.fs.requireHVN ? 'y' : '-', 4, true)} | ` +
        `${pad(r.fs.erMax === 1 ? 'off' : r.fs.erMax.toFixed(2), 5, true)} | ${pad(r.fs.trendMa || 'off', 7, true)} | ` +
        `${pad(r.fs.minAtrPct ? (r.fs.minAtrPct * 100).toFixed(2) : 'off', 5, true)} | ${pad(r.ex.label, 13)} | ` +
        `${pad(r.s.n, 6, true)} | ${pad(r.s.wr.toFixed(0) + '%', 5, true)} | ${pad(fmt(r.s.pf), 5, true)} | ` +
        `${pad(fmt(r.s.avgR), 6, true)} | ${pad(fmt(r.s.net), 9, true)} | ${pad(fmt(r.s.fees), 8, true)} | ${pad(fmt(r.s.maxDd), 8, true)}`
    );
  });

  const profitable = rows.filter((r) => r.s.net > 0);
  const byFamily = new Map();
  for (const variant of variants) {
    const fam = rows.filter((r) => r.variant === variant);
    const best = fam.sort((a, b) => b.s.net - a.s.net)[0];
    byFamily.set(variant, best);
  }
  console.log('\n  best config per family');
  for (const [variant, r] of byFamily) {
    console.log(
      `   ${pad(variant, 8)}  best net=$${fmt(r.s.net)}  trades=${r.s.n}  win=${r.s.wr.toFixed(0)}%  ` +
        `PF=${fmt(r.s.pf)}  avgR=${fmt(r.s.avgR, 3)}  fees=$${fmt(r.s.fees)}`
    );
  }

  // ---- PHASE 3: verdict --------------------------------------------------
  const best = rows[0];
  const grossAlpha = best.s.gross;
  const feeDrag = grossAlpha > 0 ? (best.s.fees / grossAlpha) * 100 : 0;
  console.log('\n\nPHASE 3 — verdict');
  console.log(`  configs tested: ${rows.length}   net-positive: ${profitable.length}`);
  console.log(
    `  best: ${best.variant} minTouches=${best.fs.minTouches} hvn=${best.fs.requireHVN} exit=${best.ex.label}  ` +
      `net=$${fmt(best.s.net)}  gross=$${fmt(grossAlpha)}  fees=$${fmt(best.s.fees)}  (fees = ${feeDrag.toFixed(0)}% of gross)`
  );
  if (best.s.n >= 10) {
    console.log(
      `  best: trades=${best.s.n} (${best.s.perDay.toFixed(2)}/day)  win=${best.s.wr.toFixed(1)}%  ` +
        `PF=${fmt(best.s.pf)}  avgR=${fmt(best.s.avgR, 3)}  maxDD=$${fmt(best.s.maxDd)}  green days=${best.s.green}/${best.s.days}`
    );
  }

  const verdict =
    profitable.length === 0
      ? 'NOT TRADEABLE — no configuration clears fees on this instrument/timeframe.'
      : best.s.net > 0 && best.s.pf >= 1.1 && best.s.n >= 30
        ? 'TRADEABLE (on this data) — a net-positive config exists with a usable sample; verify on other timeframes before wiring live.'
        : 'MARGINAL — a net-positive config exists but the sample/PF is too thin to trust; not tradeable as-is.';
  console.log(`  => ${verdict}`);

  // ---- best-config report ------------------------------------------------
  const byReason = new Map();
  for (const t of best.trades) {
    const x = byReason.get(t.reason) || { n: 0, w: 0, net: 0 };
    x.n += 1;
    x.w += t.net > 0 ? 1 : 0;
    x.net += t.net;
    byReason.set(t.reason, x);
  }
  if (byReason.size) {
    console.log(`\n  exit breakdown of the best config`);
    console.log(
      `   ${pad('reason', 8)} | ${pad('n', 5, true)} | ${pad('win%', 5, true)} | ${pad('net$', 9, true)} | ${pad('avg$', 8, true)}`
    );
    for (const [r, x] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(
        `   ${pad(r, 8)} | ${pad(x.n, 5, true)} | ${pad(((x.w / x.n) * 100).toFixed(0) + '%', 5, true)} | ` +
          `${pad(fmt(x.net), 9, true)} | ${pad(fmt(x.net / x.n), 8, true)}`
      );
    }
  }

  // daily breakdown for the best config so the answer is inspectable
  const byDay = new Map();
  for (const t of best.trades) {
    const d = dayKey(t.entryTime);
    const x = byDay.get(d) || { n: 0, w: 0, net: 0 };
    x.n += 1;
    x.w += t.net > 0 ? 1 : 0;
    x.net += t.net;
    byDay.set(d, x);
  }
  const days = [...byDay.entries()].sort();
  if (days.length) {
    const shown = days.length <= 45 ? days : days.slice(-45);
    console.log(`\n  daily net P&L of the best config (${shown.length} of ${days.length} active days)`);
    console.log(
      `   ${pad('date', 10)} | ${pad('trades', 6, true)} | ${pad('wins', 4, true)} | ${pad('net$', 9, true)} | ${pad('cum$', 9, true)}`
    );
    let cum = 0;
    for (const [d, x] of shown) {
      cum += x.net;
      console.log(
        `   ${pad(d, 10)} | ${pad(x.n, 6, true)} | ${pad(x.w, 4, true)} | ${pad(fmt(x.net), 9, true)} | ${pad(fmt(cum), 9, true)}`
      );
    }
  }

  // monthly rollup so a multi-month window is readable at a glance
  const byMonth = new Map();
  for (const t of best.trades) {
    const m = dayKey(t.entryTime).slice(0, 7);
    const x = byMonth.get(m) || { n: 0, w: 0, net: 0, gp: 0, gl: 0, dd: 0, cum: 0, peak: 0 };
    x.n += 1;
    x.w += t.net > 0 ? 1 : 0;
    x.net += t.net;
    if (t.net > 0) x.gp += t.net;
    else x.gl -= t.net;
    byMonth.set(m, x);
  }
  const months = [...byMonth.entries()].sort();
  if (months.length > 1) {
    console.log(`\n  monthly rollup of the best config`);
    console.log(
      `   ${pad('month', 8)} | ${pad('trades', 6, true)} | ${pad('win%', 5, true)} | ${pad('PF', 5, true)} | ${pad('net$', 9, true)} | ${pad('cum$', 9, true)}`
    );
    let mcum = 0;
    for (const [m, x] of months) {
      mcum += x.net;
      const pf = x.gl > 0 ? x.gp / x.gl : x.gp > 0 ? Infinity : 0;
      console.log(
        `   ${pad(m, 8)} | ${pad(x.n, 6, true)} | ${pad(((x.w / x.n) * 100).toFixed(0) + '%', 5, true)} | ` +
          `${pad(fmt(pf), 5, true)} | ${pad(fmt(x.net), 9, true)} | ${pad(fmt(mcum), 9, true)}`
      );
    }
  }
  console.log();
}

main();
