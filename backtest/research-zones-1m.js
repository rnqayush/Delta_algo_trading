// 1-MINUTE S/R ZONE ENGINE — find dynamic accumulation/distribution zones and
// decide, with a measured confidence, whether price will REJECT or BREAK them.
//
// Same philosophy as research-zones.js but tuned for the 1-minute bar, where
// everything moves ~12x faster than on 5m:
//
//   PHASE 1 — FIND dynamic zones.
//     * fractal pivots confirm k bars late (no look-ahead).
//     * pivots cluster into a zone; the cluster re-centres on a volume-weighted
//       mean and widens to fit, so the zone is LIVE, not a frozen line.
//     * each zone carries a decaying STRENGTH = touches x 0.5^(age/halfLife):
//       a level that keeps getting hit is strong, one that has gone quiet for
//       hours has faded and is retired.
//     * a band sitting on a HIGH-VOLUME NODE is an accumulation/distribution
//       shelf; its position inside the trailing range labels it acc (bottom
//       third), dist (top third) or mid.
//     * every approach is resolved as REJECT (held) or BREAK (gave way) and the
//       result is bucketed by zone quality and by the approaching momentum, so
//       we get a CALIBRATED confidence table rather than a hunch.
//
//   PHASE 2 — TRADE it. fade (limit at the edge = maker), fadeCnf (taker on a
//     confirmed close back outside) and retest (flipped polarity). Real Delta
//     fees: 2bps maker / 5bps taker + 2bps slip on market exits.
//
//   PHASE 3 — VERDICT on a 7-day window (zones still built on the full 30-day
//     cache for context): is anything net-positive, and how much of the raw
//     edge survives the spread?
//
//   node backtest/research-zones-1m.js                 # 7-day report, real fees
//   node backtest/research-zones-1m.js --days 7 --nofee
//   node backtest/research-zones-1m.js --days 14
'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const TF = '1m';

// Real Delta perp schedule; --nofee zeroes it to expose the raw edge.
const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

const CFG = {
  contractValue: 0.001,
  feeMaker: REAL.maker,
  feeTaker: REAL.taker,
  slippage: REAL.slip,
  initialEquity: 1200,
  riskPct: 0.005, // 0.5% of equity per trade
  maxNotionalPct: 3,
};

// 1m geometry. pivotK=3 confirms a turn 3 minutes after it forms (vs 5 on the
// higher timeframes); ATR gives pulse-width bands; the half-life makes a zone's
// strength fade over ~1.5h of silence.
const P = {
  pivotK: 3,
  zoneAtrMult: 0.5,
  mergeAtrMult: 0.75,
  maxZoneAgeBars: 120,
  halfLifeBars: 90,
  atrPeriod: 14,
  volWindow: 240, // 4h trailing volume profile
  volBinAtr: 0.5,
  hvnMult: 1.3,
  // strategy
  minTouches: 2,
  requireHVN: false,
  minStrength: 0,
  breakoutBufAtr: 0.1,
  proximityAtr: 0.5,
  stopBufAtr: 0.25,
  retestWindowBars: 10,
  exitMode: 'target',
  targetR: 1.5,
  beAtR: 0.5,
  trailAtrMult: 2,
  holdBars: 30, // 30 minutes max hold
  erMin: 0,
  erMax: 1,
  trendMa: 0,
  minAtrPct: 0,
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
// PHASE 1 — dynamic zone engine
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

// Trailing volume profile as-of endIdx (no look-ahead) + where the zone sits
// inside the traded range, which is what labels accumulation vs distribution.
function profileInfo(candles, endIdx, bin, window) {
  const from = Math.max(0, endIdx - window);
  const vols = new Map();
  let minTp = Infinity, maxTp = -Infinity;
  for (let m = from; m <= endIdx; m += 1) {
    const c = candles[m];
    const tp = (c.high + c.low + c.close) / 3;
    const b = Math.floor(tp / bin);
    vols.set(b, (vols.get(b) || 0) + c.volume);
    if (tp < minTp) minTp = tp;
    if (tp > maxTp) maxTp = tp;
  }
  const vals = [...vols.values()];
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  return { vols, mean, minTp, maxTp };
}

function classifyZone(candles, endIdx, atrV, center, lo, hi, p) {
  const bin = Math.max(1e-9, atrV * p.volBinAtr);
  const prof = profileInfo(candles, endIdx, bin, p.volWindow);
  const b0 = Math.floor(lo / bin);
  const b1 = Math.floor(hi / bin);
  let band = 0;
  for (let b = b0; b <= b1; b += 1) band += prof.vols.get(b) || 0;
  const avgBand = band / Math.max(1, b1 - b0 + 1);
  const hvn = prof.mean > 0 && avgBand >= prof.mean * p.hvnMult;
  const range = prof.maxTp - prof.minTp;
  const pos = range > 0 ? (center - prof.minTp) / range : 0.5;
  const kind = pos < 0.33 ? 'acc' : pos > 0.67 ? 'dist' : 'mid';
  return { hvn, kind, volRatio: prof.mean > 0 ? avgBand / prof.mean : 1 };
}

// Single forward pass. Zones stay LIVE: the cluster re-centres on a
// volume-weighted mean, widens to fit, and decays when it goes quiet.
function buildZones(candles, atrArr, p) {
  const n = candles.length;
  const table = [];
  const zoneAt = new Array(n);
  const zones = [];

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
      const w = candles[barIdx].volume;
      const totalW = best.vol + w;
      best.center = (best.center * best.vol + price * w) / (totalW || 1);
      best.vol = totalW;
      best.halfWidth = Math.max(best.halfWidth, atrV * p.zoneAtrMult);
      best.low = best.center - best.halfWidth;
      best.high = best.center + best.halfWidth;
      best.touches += 1;
      best.lastPivotBar = barIdx;
      return;
    }
    const hw = Math.max(1e-9, atrV * p.zoneAtrMult);
    const lo = price - hw;
    const hi = price + hw;
    const info = classifyZone(candles, barIdx, atrV, price, lo, hi, p);
    const id = table.length;
    table.push({
      id,
      center: price,
      halfWidth: hw,
      low: lo,
      high: hi,
      touches: 1,
      firstPivotBar: barIdx,
      lastPivotBar: barIdx,
      vol: candles[barIdx].volume,
      hvn: info.hvn,
      kind: info.kind,
      brokenUpAt: null,
      brokenDownAt: null,
    });
    zones.push(id);
  };

  for (let i = 0; i < n; i += 1) {
    const j = i - p.pivotK; // pivot at j is only knowable now
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
    zoneAt[i] = zones.slice();
  }

  return { table, zoneAt };
}

// decaying strength of a zone at bar i
function zoneStrength(z, i, p) {
  return z.touches * Math.pow(0.5, (i - z.lastPivotBar) / p.halfLifeBars);
}

// Grades every approach: did the zone hold (reject) or give way (break)?
function gradeZones(candles, table, zoneAt, atrArr, erArr, horizon, p) {
  const n = candles.length;
  const state = new Map();
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

      if (prev === 'above' && pos === 'inside') {
        events.push(resolve(candles, table, id, i, 'support', horizon, atrArr, erArr, p));
      } else if (prev === 'below' && pos === 'inside') {
        events.push(resolve(candles, table, id, i, 'resistance', horizon, atrArr, erArr, p));
      }
      state.set(id, pos);
    }
  }
  return events.filter(Boolean);
}

function resolve(candles, table, id, i, role, horizon, atrArr, erArr, p) {
  const z = table[id];
  const a = atrArr[i] || 1;
  // approach momentum over the last 10 bars, ATR-normalised
  const back = Math.max(0, i - 10);
  const mom = (candles[i].close - candles[back].close) / (a * Math.max(1, i - back));
  const end = Math.min(candles.length - 1, i + horizon);
  const base = {
    role,
    touches: z.touches,
    hvn: z.hvn,
    kind: z.kind,
    strength: zoneStrength(z, i, p),
    mom,
    er: erArr[i],
    time: candles[i].time,
    widthAtr: z.halfWidth / a,
  };
  for (let m = i + 1; m <= end; m += 1) {
    const c = candles[m].close;
    if (role === 'support') {
      if (c < z.low) return { ...base, outcome: 'break', bars: m - i };
      if (c > z.high) return { ...base, outcome: 'reject', bars: m - i };
    } else {
      if (c > z.high) return { ...base, outcome: 'break', bars: m - i };
      if (c < z.low) return { ...base, outcome: 'reject', bars: m - i };
    }
  }
  return { ...base, outcome: 'unresolved', bars: horizon };
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

function runStrategy(candles, table, zoneAt, atrArr, erArr, emaArr, p, variant) {
  const n = candles.length;
  const trades = [];
  let pos = null;
  let pending = null;

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

  const zoneOk = (z, i) => {
    if (z.touches < p.minTouches) return false;
    if (p.requireHVN && !z.hvn) return false;
    if (p.minStrength > 0 && zoneStrength(z, i, p) < p.minStrength) return false;
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

  const warmup = Math.max(p.pivotK * 2 + 1, p.atrPeriod * 3, 60);

  for (let i = warmup; i < n; i += 1) {
    const bar = candles[i];
    const a = atrArr[i];
    if (!a) continue;
    const ids = zoneAt[i] || [];

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

    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
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

    const e = erArr[i];
    if (e !== null && (e < p.erMin || e > p.erMax)) continue;

    if (variant === 'retest') {
      for (const id of ids) {
        const z = table[id];
        if (!zoneOk(z, i)) continue;
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
        if (!zoneOk(z, i)) continue;
        const prevClose = candles[i - 1].close;
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
      for (const id of ids) {
        const z = table[id];
        if (!zoneOk(z, i)) continue;
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
  const a = { days: 7, nofee: false, horizon: 30 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--nofee') a.nofee = true;
    else if (argv[i] === '--horizon') a.horizon = Number(argv[++i]);
  }
  return a;
}

function bucketTouches(t) {
  return t >= 4 ? '4+' : String(t);
}

function momBucket(m) {
  const a = Math.abs(m);
  if (a < 0.15) return 'slow<0.15';
  if (a < 0.4) return 'med0.15-0.4';
  return 'fast>0.4';
}

function printReliability(title, events) {
  console.log(`\n${title}  (n=${events.length})`);
  const byBucket = new Map();
  for (const e of events) {
    const key = `${e.role} | t${bucketTouches(e.touches)} | ${e.hvn ? 'HVN' : 'quiet'} | ${e.kind} | ${momBucket(e.mom)}`;
    const b = byBucket.get(key) || { n: 0, brk: 0, rej: 0, un: 0, bars: 0 };
    b.n += 1;
    if (e.outcome === 'break') b.brk += 1;
    else if (e.outcome === 'reject') { b.rej += 1; b.bars += e.bars; }
    else b.un += 1;
    byBucket.set(key, b);
  }
  const keys = [...byBucket.keys()].sort();
  console.log(
    `  ${pad('zone class', 44)} | ${pad('n', 6, true)} | ${pad('%break', 7, true)} | ${pad('%reject', 8, true)} | ${pad('avg bars', 9, true)}`
  );
  console.log('  ' + '-'.repeat(92));
  for (const k of keys) {
    const b = byBucket.get(k);
    console.log(
      `  ${pad(k, 44)} | ${pad(b.n, 6, true)} | ${pad(((b.brk / b.n) * 100).toFixed(0) + '%', 7, true)} | ` +
        `${pad(((b.rej / b.n) * 100).toFixed(0) + '%', 8, true)} | ${pad(b.rej ? (b.bars / b.rej).toFixed(1) : '-', 9, true)}`
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

  const cached = loadCache(SYMBOL, TF);
  if (!cached) throw new Error(`No ${TF} cache. Run: node backtest/fetch.js --symbol ${SYMBOL} --timeframes ${TF}`);

  const candles = cached.candles;
  if (candles.length < 500) throw new Error(`Not enough bars (${candles.length})`);
  const cutoff = candles[candles.length - 1].time - args.days * 86400;

  const atrArr = atr(candles, P.atrPeriod);
  const erArr = erSeries(candles, 10);
  const emaArr = ema(candles.map((c) => c.close), 200);
  const { table, zoneAt } = buildZones(candles, atrArr, P);

  const first = dayKey(candles[0].time);
  const last = dayKey(candles[candles.length - 1].time);

  console.log('============================================================');
  console.log(
    ` 1-MIN S/R ZONE ENGINE — ${SYMBOL} ${TF}   data ${first} -> ${last}  (${candles.length} bars)   REPORT: last ${args.days}d`
  );
  console.log(
    ` costs  maker ${(CFG.feeMaker * 1e4).toFixed(1)}bps / taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + ` +
      `${(CFG.slippage * 1e4).toFixed(1)}bps slip${args.nofee ? '   [ZERO-COST MODE]' : ''}`
  );
  console.log(
    ` zones  pivotK=${P.pivotK} width=${P.zoneAtrMult}ATR merge=${P.mergeAtrMult}ATR halfLife=${P.halfLifeBars}bars age<=${P.maxZoneAgeBars}bars`
  );
  console.log('============================================================');

  // ---- PHASE 1 ----------------------------------------------------------
  const withHVN = table.filter((z) => z.hvn).length;
  const acc = table.filter((z) => z.kind === 'acc').length;
  const dist = table.filter((z) => z.kind === 'dist').length;
  const touchHist = new Map();
  for (const z of table) touchHist.set(z.touches, (touchHist.get(z.touches) || 0) + 1);
  console.log('\nPHASE 1 — dynamic zones found');
  console.log(`  total zones: ${table.length}   HVN shelves: ${withHVN} (${((withHVN / table.length) * 100).toFixed(0)}%)`);
  console.log(`  by location: accumulation ${acc}   mid ${table.length - acc - dist}   distribution ${dist}`);
  console.log(
    `  touch histogram: ` +
      [...touchHist.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => `${t}x:${c}`).join('  ')
  );

  const eventsAll = gradeZones(candles, table, zoneAt, atrArr, erArr, args.horizon, P);
  const events = eventsAll.filter((e) => e.time >= cutoff);
  console.log(`\n  zone reliability (${args.horizon} bars after each approach, report window):`);
  printReliability('  ALL APPROACHES', events);
  const strong = events.filter((e) => e.touches >= 2);
  if (strong.length) printReliability('  ZONES WITH >=2 TOUCHES', strong);
  const slow = events.filter((e) => Math.abs(e.mom) < 0.15);
  if (slow.length) printReliability('  SLOW APPROACH (|mom| < 0.15 ATR/bar)', slow);
  const fast = events.filter((e) => Math.abs(e.mom) >= 0.4);
  if (fast.length) printReliability('  FAST APPROACH (|mom| >= 0.4 ATR/bar)', fast);

  // Decision matrix: P(zone holds) as a function of zone strength x approach
  // speed. This is the "confident" part — where to expect a rejection and where
  // to expect a break, instead of treating every level the same.
  const resolved = events.filter((e) => e.outcome === 'reject' || e.outcome === 'break');
  const cells = [];
  for (const tBand of [{ k: 'weak (1-2)', f: (t) => t <= 2 }, { k: 'strong (3+)', f: (t) => t >= 3 }]) {
    for (const mBand of [
      { k: 'slow <0.15', f: (m) => Math.abs(m) < 0.15 },
      { k: 'med 0.15-0.4', f: (m) => Math.abs(m) >= 0.15 && Math.abs(m) < 0.4 },
      { k: 'fast >=0.4', f: (m) => Math.abs(m) >= 0.4 },
    ]) {
      const set = resolved.filter((e) => tBand.f(e.touches) && mBand.f(e.mom));
      const rej = set.filter((e) => e.outcome === 'reject').length;
      cells.push({ t: tBand.k, m: mBand.k, n: set.length, rej });
    }
  }
  console.log('\n  DECISION MATRIX — P(the zone HOLDS / rejects) in the report window');
  console.log(`   ${pad('zone strength', 14)} | ${pad('slow <0.15', 18, true)} | ${pad('med 0.15-0.4', 18, true)} | ${pad('fast >=0.4', 18, true)}`);
  console.log('   ' + '-'.repeat(76));
  for (const tBand of ['weak (1-2)', 'strong (3+)']) {
    const cols = ['slow <0.15', 'med 0.15-0.4', 'fast >=0.4'].map((mk) => {
      const c = cells.find((x) => x.t === tBand && x.m === mk);
      return c && c.n ? `${((c.rej / c.n) * 100).toFixed(0)}% (n=${c.n})` : '-';
    });
    console.log(`   ${pad(tBand, 14)} | ${pad(cols[0], 18, true)} | ${pad(cols[1], 18, true)} | ${pad(cols[2], 18, true)}`);
  }

  // ---- PHASE 2 ----------------------------------------------------------
  console.log('\n\nPHASE 2 — tuning grid (1m, report window only)');
  const variants = ['fade', 'fadeCnf', 'retest'];
  const filterSets = [];
  for (const minTouches of [2, 3]) {
    for (const requireHVN of [false, true]) {
      for (const erMax of [1, 0.45]) {
        for (const minAtrPct of [0, 0.0008]) {
          filterSets.push({ minTouches, requireHVN, erMax, minAtrPct });
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
        for (const z of table) {
          z.brokenUpAt = null;
          z.brokenDownAt = null;
        }
        const p = { ...P, ...fs, ...ex };
        const allTrades = runStrategy(candles, table, zoneAt, atrArr, erArr, emaArr, p, variant);
        const trades = allTrades.filter((t) => t.entryTime >= cutoff);
        rows.push({ variant, fs, ex, p, s: summarise(trades), trades });
      }
    }
  }

  rows.sort((a, b) => b.s.net - a.s.net);
  console.log(
    `\n ${pad('rank', 4)} | ${pad('family', 8)} | ${pad('minT', 4, true)} | ${pad('HVN', 4, true)} | ${pad('ER<=', 5, true)} | ` +
      `${pad('atr%', 5, true)} | ${pad('exit', 13)} | ${pad('trades', 6, true)} | ${pad('win%', 5, true)} | ` +
      `${pad('PF', 5, true)} | ${pad('avgR', 6, true)} | ${pad('net$', 9, true)} | ${pad('fees$', 8, true)} | ${pad('maxDD$', 8, true)}`
  );
  console.log(' ' + '-'.repeat(140));
  rows.slice(0, 15).forEach((r, i) => {
    console.log(
      ` ${pad(i + 1, 4)} | ${pad(r.variant, 8)} | ${pad(r.fs.minTouches, 4, true)} | ${pad(r.fs.requireHVN ? 'y' : '-', 4, true)} | ` +
        `${pad(r.fs.erMax === 1 ? 'off' : r.fs.erMax.toFixed(2), 5, true)} | ${pad(r.fs.minAtrPct ? (r.fs.minAtrPct * 100).toFixed(2) : 'off', 5, true)} | ` +
        `${pad(r.ex.label, 13)} | ${pad(r.s.n, 6, true)} | ${pad(r.s.wr.toFixed(0) + '%', 5, true)} | ${pad(fmt(r.s.pf), 5, true)} | ` +
        `${pad(fmt(r.s.avgR), 6, true)} | ${pad(fmt(r.s.net), 9, true)} | ${pad(fmt(r.s.fees), 8, true)} | ${pad(fmt(r.s.maxDd), 8, true)}`
    );
  });

  const profitable = rows.filter((r) => r.s.net > 0);

  // The config wired into the live strategy (src/strategies/strategies/
  // srZoneFade1m.js) must be findable in the grid, otherwise live and backtest
  // have drifted apart. Keep this in sync with that module's F block.
  const LIVE = { variant: 'fade', minTouches: 3, requireHVN: false, erMax: 0.45, minAtrPct: 0.0008, exit: 'TP1R' };
  const live = rows.find(
    (r) =>
      r.variant === LIVE.variant &&
      r.fs.minTouches === LIVE.minTouches &&
      r.fs.requireHVN === LIVE.requireHVN &&
      r.fs.erMax === LIVE.erMax &&
      r.fs.minAtrPct === LIVE.minAtrPct &&
      r.ex.label === LIVE.exit
  );
  if (live) {
    console.log('\n  LIVE CONFIG — SrZoneFade1m (fade, minT=3, ER<=0.45, atr%=0.08, TP1R)');
    console.log(
      `   trades=${live.s.n}  win=${live.s.wr.toFixed(1)}%  PF=${fmt(live.s.pf)}  avgR=${fmt(live.s.avgR, 3)}  ` +
        `net=$${fmt(live.s.net)}  gross=$${fmt(live.s.gross)}  fees=$${fmt(live.s.fees)}`
    );
  }
  // Family best needs a sample we can trust (>=20 trades): picking the config
  // that traded twice and dodged fees is not a strategy, it is a rounding error.
  const MIN_N = 20;
  const byFamily = new Map();
  for (const variant of variants) {
    const fam = rows.filter((r) => r.variant === variant);
    const trustworthy = fam.filter((r) => r.s.n >= MIN_N).sort((a, b) => b.s.net - a.s.net);
    byFamily.set(variant, trustworthy[0] || fam.sort((a, b) => b.s.net - a.s.net)[0]);
  }
  console.log(`\n  best config per family (sample >= ${MIN_N} trades where available)`);
  for (const [variant, r] of byFamily) {
    console.log(
      `   ${pad(variant, 8)}  net=$${fmt(r.s.net)}  trades=${r.s.n}  win=${r.s.wr.toFixed(0)}%  ` +
        `PF=${fmt(r.s.pf)}  avgR=${fmt(r.s.avgR, 3)}  fees=$${fmt(r.s.fees)}`
    );
    console.log(
      `            params: minT=${r.fs.minTouches} hvn=${r.fs.requireHVN} ER<=${r.fs.erMax} atr%=${r.fs.minAtrPct} exit=${r.ex.label}`
    );
  }

  // ---- PHASE 3 ----------------------------------------------------------
  const best = rows[0];
  const feeDrag = best.s.gross > 0 ? (best.s.fees / best.s.gross) * 100 : 0;
  console.log('\n\nPHASE 3 — verdict');
  console.log(`  configs tested: ${rows.length}   net-positive: ${profitable.length}`);
  console.log(
    `  best: ${best.variant} minT=${best.fs.minTouches} hvn=${best.fs.requireHVN} ER<=${best.fs.erMax} atr%=${best.fs.minAtrPct} exit=${best.ex.label}`
  );
  console.log(
    `  best: net=$${fmt(best.s.net)}  gross=$${fmt(best.s.gross)}  fees=$${fmt(best.s.fees)}  (fees = ${feeDrag.toFixed(0)}% of gross)`
  );
  console.log(
    `  best: trades=${best.s.n} (${best.s.perDay.toFixed(1)}/day)  win=${best.s.wr.toFixed(1)}%  ` +
      `PF=${fmt(best.s.pf)}  avgR=${fmt(best.s.avgR, 3)}  maxDD=$${fmt(best.s.maxDd)}  green days=${best.s.green}/${best.s.days}`
  );

  const verdict =
    profitable.length === 0
      ? 'NOT TRADEABLE — no configuration clears 1m fees on BTCUSD. The 1m zone edge is real but smaller than the round-trip cost.'
      : best.s.net > 0 && best.s.pf >= 1.1 && best.s.n >= 30
        ? 'TRADEABLE-ISH (best config) — net-positive with a usable sample on this window; treat 1m costs as the binding constraint and re-check on another week.'
        : 'MARGINAL — a net-positive config exists but the sample/PF is too thin to trust.';
  console.log(`  => ${verdict}`);

  // daily breakdown of the best config (the 7-day report)
  const byDay = new Map();
  for (const t of best.trades) {
    const d = dayKey(t.entryTime);
    const x = byDay.get(d) || { n: 0, w: 0, net: 0, fees: 0 };
    x.n += 1;
    x.w += t.net > 0 ? 1 : 0;
    x.net += t.net;
    x.fees += t.fees;
    byDay.set(d, x);
  }
  const days = [...byDay.entries()].sort();
  if (days.length) {
    console.log(`\n  DAILY REPORT — best config (${days.length} active days)`);
    console.log(
      `   ${pad('date', 10)} | ${pad('trades', 6, true)} | ${pad('wins', 4, true)} | ${pad('win%', 5, true)} | ${pad('fees$', 8, true)} | ${pad('net$', 9, true)} | ${pad('cum$', 9, true)}`
    );
    let cum = 0;
    for (const [d, x] of days) {
      cum += x.net;
      console.log(
        `   ${pad(d, 10)} | ${pad(x.n, 6, true)} | ${pad(x.w, 4, true)} | ${pad(((x.w / x.n) * 100).toFixed(0) + '%', 5, true)} | ` +
          `${pad(fmt(x.fees), 8, true)} | ${pad(fmt(x.net), 9, true)} | ${pad(fmt(cum), 9, true)}`
      );
    }
  }

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

  // ---- SIGNAL-VOLUME LADDER --------------------------------------------
  // Holds the live family and exit fixed (fade, TP1R) and ONLY relaxes the
  // filters, so the single thing changing is how many setups the engine is
  // allowed to take. This is the "what happens if we create more signals"
  // curve: does the extra volume add edge, or just add fee exposure?
  const ladder = [
    { label: 'LIVE  minT3 ER<=.45 atr%.08', minTouches: 3, erMax: 0.45, minAtrPct: 0.0008, proximityAtr: 0.5 },
    { label: 'minT3 ER<=.60 atr%.08', minTouches: 3, erMax: 0.6, minAtrPct: 0.0008, proximityAtr: 0.5 },
    { label: 'minT3 ER off atr%.08', minTouches: 3, erMax: 1, minAtrPct: 0.0008, proximityAtr: 0.5 },
    { label: 'minT3 ER off atr%.04', minTouches: 3, erMax: 1, minAtrPct: 0.0004, proximityAtr: 0.5 },
    { label: 'minT3 ER off atr% off', minTouches: 3, erMax: 1, minAtrPct: 0, proximityAtr: 0.5 },
    { label: 'minT2 ER off atr% off', minTouches: 2, erMax: 1, minAtrPct: 0, proximityAtr: 0.5 },
    { label: 'minT1 ER off atr% off', minTouches: 1, erMax: 1, minAtrPct: 0, proximityAtr: 0.5 },
    { label: 'minT2 prox1ATR atr% off', minTouches: 2, erMax: 1, minAtrPct: 0, proximityAtr: 1 },
  ];
  console.log('\n\nSIGNAL-VOLUME LADDER — fade family, TP1R exit, gates relaxed step by step');
  console.log(
    `   ${pad('config', 30)} | ${pad('trades', 6, true)} | ${pad('/day', 5, true)} | ${pad('win%', 5, true)} | ` +
      `${pad('PF', 5, true)} | ${pad('avgR', 6, true)} | ${pad('net$', 9, true)} | ${pad('fees$', 8, true)} | ${pad('maxDD$', 8, true)}`
  );
  console.log('   ' + '-'.repeat(118));
  let liveTrades = null;
  for (const cfg of ladder) {
    for (const z of table) {
      z.brokenUpAt = null;
      z.brokenDownAt = null;
    }
    const p = { ...P, ...cfg, requireHVN: false, exitMode: 'target', targetR: 1 };
    const all = runStrategy(candles, table, zoneAt, atrArr, erArr, emaArr, p, 'fade');
    const tr = all.filter((t) => t.entryTime >= cutoff);
    if (cfg === ladder[0]) liveTrades = tr;
    const s = summarise(tr);
    console.log(
      `   ${pad(cfg.label, 30)} | ${pad(s.n, 6, true)} | ${pad(s.perDay.toFixed(1), 5, true)} | ${pad(s.wr.toFixed(0) + '%', 5, true)} | ` +
        `${pad(fmt(s.pf), 5, true)} | ${pad(fmt(s.avgR, 3), 6, true)} | ${pad(fmt(s.net), 9, true)} | ${pad(fmt(s.fees), 8, true)} | ${pad(fmt(s.maxDd), 8, true)}`
    );
  }

  // Per-day signal count for the ACTIVE config, so "how many signals in the
  // last 7 days" has a concrete number rather than a rate.
  if (liveTrades) {
    const per = new Map();
    for (const t of liveTrades) {
      const d = dayKey(t.entryTime);
      const x = per.get(d) || { n: 0, w: 0, net: 0 };
      x.n += 1;
      x.w += t.net > 0 ? 1 : 0;
      x.net += t.net;
      per.set(d, x);
    }
    const rows2 = [...per.entries()].sort();
    console.log(`\nSIGNALS PER DAY — ACTIVE CONFIG (SrZoneFade1m):  total ${liveTrades.length} over ${rows2.length} days`);
    console.log(`   ${pad('date', 10)} | ${pad('signals', 7, true)} | ${pad('wins', 4, true)} | ${pad('win%', 5, true)} | ${pad('net$', 9, true)}`);
    for (const [d, x] of rows2) {
      console.log(
        `   ${pad(d, 10)} | ${pad(x.n, 7, true)} | ${pad(x.w, 4, true)} | ${pad(((x.w / x.n) * 100).toFixed(0) + '%', 5, true)} | ${pad(fmt(x.net), 9, true)}`
      );
    }
  }

  console.log();
}

main();
