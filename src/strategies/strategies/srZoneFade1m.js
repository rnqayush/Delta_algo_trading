// Support/Resistance zone FADE on the 1-MINUTE chart (BTCUSD).
//
// Ported from backtest/research-zones-1m.js. The 1m research built DYNAMIC
// zones from confirmed fractal pivots (pivotK=3, so a turn is only used 3 bars
// after it happens), clustered nearby pivots into ATR-scaled bands that keep
// re-centring on a volume-weighted mean, and tagged each band with a strength
// that decays over time and a location label (accumulation / mid /
// distribution) taken from where the band sits in the trailing range.
//
// The 7-day study produced a calibrated decision table: strong zones (3+
// touches) HOLD on 63-65% of approaches, weak zones (1-2 touches) are a coin
// flip (~50%), and a fast approach (>=0.4 ATR/bar) drops the hold rate, i.e.
// momentum approaches break more often. This module only fades the strong,
// slow-approach case — the one the data actually supports.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the dynamic zones from the 1m window (no look-ahead);
//   2. mark the zones that have already given way so a failed level is never
//      faded from the broken side;
//   3. take the first zone the bar is drifting INTO (support from above, or
//      resistance from below) within `proximityAtr` of the edge;
//   4. keep only setups that pass the 1m filter set: 3+ touches, a ranging
//      regime (ER <= 0.45), price on the EMA-200 side (trade with the drift),
//      and an ATR% volatility floor so dead chop is skipped;
//   5. enter with a resting MAKER limit at the zone edge and send the stop
//      (0.25 ATR beyond the far edge) and the 1R target as an on-exchange
//      reduce-only bracket, so the trade is protected on Delta itself.
//
// NOTE ON COST: the 1m backtest showed the raw signal edge is real but the
// round-trip fee (~7bps) consumes ~98% of it at ~50 trades/day. This module is
// deliberately gated hard (3+ touches, ER, ATR floor, one entry per bar) so it
// fires far less often than the raw signal, but it is still a 1m system — treat
// fees as the binding constraint.
//
// One limit is armed per closed 1m bar at most, and nothing is sent while a
// position or a resting entry already exists.

const ONE_MIN_MS = 60 * 1000;

// --- 1m zone geometry (identical to backtest/research-zones-1m.js) ----------
const Z = {
  pivotK: 3, // fractal half-width: a 1m pivot is confirmed 3 bars late
  zoneAtrMult: 0.5, // zone half-width = 0.5 x ATR
  mergeAtrMult: 0.75, // pivots within 0.75 x ATR of a centre join that zone
  maxZoneAgeBars: 120, // a zone with no new pivot for 2h is retired
  halfLifeBars: 90, // zone strength halves every 90 silent bars
  atrPeriod: 14,
  volWindow: 240, // 4h trailing volume profile
  volBinAtr: 0.5, // profile bin height = 0.5 x ATR
  hvnMult: 1.3, // band must beat this multiple of the mean bin to be an HVN
};

// --- the 1m filter set + exit -----------------------------------------------
const F = {
  minTouches: 3, // the decision table only supports strong (3+) zones
  requireHVN: false, // backtest: no HVN requirement for the top fade config
  minStrength: 0, // 0 = off; else require touches*0.5^(age/halfLife) >= this
  erMax: 0.45, // trade only when the Kaufman efficiency ratio is at or below this
  trendMa: 200, // EMA-200 on the 1m chart: fade only with the drift
  minAtrPct: 0.0008, // volatility floor (ATR as a fraction of price)
  proximityAtr: 0.5, // the close must be within this x ATR of the zone edge
  stopBufAtr: 0.25, // stop sits this x ATR beyond the far edge
  targetR: 1, // take profit at 1R — the 1m sweep's best fade exit (62% win)
  entryValidityBars: 10, // informative: the resting limit lives ~10 minutes
};

const ER_PERIOD = 10;
const EMA_PERIOD = 200;
// Enough bars for the EMA-200 and the volume profile to have values, plus room
// for the pivot confirmations. Below this the strategy just warms up.
const MIN_BARS = Math.max(EMA_PERIOD, Z.volWindow) + Z.pivotK * 2 + 10;

// ---------------------------------------------------------------------------
// Indicators (same maths as the research script)
// ---------------------------------------------------------------------------

function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// Kaufman efficiency ratio: |net move| / |total travel| over `period` bars.
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

// Trailing volume profile as-of endIdx (no look-ahead) + where the band sits in
// the traded range, which is what labels accumulation vs distribution.
function classifyZone(candles, endIdx, atrV, center, lo, hi) {
  const bin = Math.max(1e-9, atrV * Z.volBinAtr);
  const from = Math.max(0, endIdx - Z.volWindow);
  const vols = new Map();
  let minTp = Infinity;
  let maxTp = -Infinity;
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
  const b0 = Math.floor(lo / bin);
  const b1 = Math.floor(hi / bin);
  let band = 0;
  for (let b = b0; b <= b1; b += 1) band += vols.get(b) || 0;
  const avgBand = band / Math.max(1, b1 - b0 + 1);
  const hvn = mean > 0 && avgBand >= mean * Z.hvnMult;
  const range = maxTp - minTp;
  const pos = range > 0 ? (center - minTp) / range : 0.5;
  const kind = pos < 0.33 ? 'acc' : pos > 0.67 ? 'dist' : 'mid';
  return { hvn, kind };
}

// Single forward pass. A pivot at bar j is only used once bar j + pivotK has
// closed, so `zoneAt[i]` (the zones visible at bar i) never contains a level
// that was only knowable later.
function buildZones(candles, atrArr) {
  const n = candles.length;
  const table = [];
  const zoneAt = new Array(n);
  const zones = []; // active zone ids

  const touch = (price, barIdx, atrV) => {
    const tol = atrV * Z.mergeAtrMult;
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
      best.halfWidth = Math.max(best.halfWidth, atrV * Z.zoneAtrMult);
      best.low = best.center - best.halfWidth;
      best.high = best.center + best.halfWidth;
      best.touches += 1;
      best.lastPivotBar = barIdx;
      return;
    }
    const hw = Math.max(1e-9, atrV * Z.zoneAtrMult);
    const info = classifyZone(candles, barIdx, atrV, price, price - hw, price + hw);
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
      hvn: info.hvn,
      kind: info.kind,
      brokenUpAt: null,
      brokenDownAt: null,
    });
    zones.push(id);
  };

  for (let i = 0; i < n; i += 1) {
    const j = i - Z.pivotK;
    if (j >= Z.pivotK) {
      const a = atrArr[j];
      if (a && a > 0) {
        if (isPivotHigh(candles, j, Z.pivotK)) touch(candles[j].high, j, a);
        if (isPivotLow(candles, j, Z.pivotK)) touch(candles[j].low, j, a);
      }
    }
    for (let z = zones.length - 1; z >= 0; z -= 1) {
      if (i - table[zones[z]].lastPivotBar > Z.maxZoneAgeBars) zones.splice(z, 1);
    }
    zoneAt[i] = zones.slice(); // ids visible at bar i
  }

  return { table, zoneAt };
}

// Decaying strength of a zone at bar i: hits matter, but a level that has gone
// quiet for hours has faded.
function zoneStrength(z, i) {
  return z.touches * Math.pow(0.5, (i - z.lastPivotBar) / Z.halfLifeBars);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class SrZoneFade1m {
  constructor() {
    this.name = 'SrZoneFade1m';
    this.description =
      'Dynamic support/resistance fade on the 1m chart: a confirmed pivot zone (3+ touches) is faded ' +
      'when price drifts into its edge (maker limit at the edge), filtered to ranging regimes (ER<=0.45), ' +
      'with the EMA-200 drift and above an ATR% volatility floor. Stop 0.25 ATR beyond the far edge, ' +
      'target 1R, both resting on the exchange as reduce-only bracket orders.';
    this.symbol = 'BTCUSD';

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.5;
    this.contractValue = 0.001;
    this.equity = 1200;
    this.riskPercent = 0.005;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    this.fixedContracts = 0;
    this.maxConcurrentPositions = 1;

    // One signal per closed 1m bar.
    this.lastBarTime = 0;

    // Per-bar indicator/zone cache, keyed by the last closed bar's time, so the
    // zone rebuild runs once per bar rather than on every tick.
    this.cache = { time: 0, table: null, zoneAt: null, atrArr: null, erArr: null, emaArr: null };
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0;
    this.cache = { time: 0, table: null, zoneAt: null, atrArr: null, erArr: null, emaArr: null };
  }

  // Risk-based size, floored at the exchange minimum. A fixed size (set from
  // the env) bypasses the maths entirely — that is what a tiny account uses.
  sizeContracts(entry, stop) {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));

    const dist = Math.abs(Number(entry) - Number(stop));
    if (!(dist > 0)) return Math.max(1, Number(this.minContracts) || 1);

    const equity = Number(this.equity) || 0;
    const riskAmount = equity * (Number(this.riskPercent) || 0);
    const byRisk = Math.floor(riskAmount / (dist * (Number(this.contractValue) || 0.001)));
    const byNotional = Math.floor(
      (equity * (Number(this.maxNotionalEquity) || 0)) / (Number(entry) * (Number(this.contractValue) || 0.001))
    );
    const size = Math.min(byRisk, byNotional);
    return Math.max(Number(this.minContracts) || 1, size);
  }

  // Rounds a price to the product's tick size (BTCUSD = 0.5).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  // Rebuilds the zone table and the indicator series for the current window.
  computeContext(candles) {
    const atrArr = atr(candles, Z.atrPeriod);
    const erArr = erSeries(candles, ER_PERIOD);
    const emaArr = ema(candles.map((c) => c.close), EMA_PERIOD);
    const { table, zoneAt } = buildZones(candles, atrArr);

    // Mark the zones that have already given way. A close beyond an edge means
    // the level failed on that side; a failed level must not be faded from it.
    // Only bars the zone was visible for are considered (no look-ahead).
    for (let i = 0; i < candles.length; i += 1) {
      const ids = zoneAt[i];
      if (!ids || !ids.length) continue;
      const bar = candles[i];
      for (const id of ids) {
        const z = table[id];
        if (z.brokenUpAt === null && bar.close > z.high) z.brokenUpAt = i;
        else if (z.brokenDownAt === null && bar.close < z.low) z.brokenDownAt = i;
      }
    }

    this.cache = { time: candles[candles.length - 1].time, table, zoneAt, atrArr, erArr, emaArr };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    // Single bracket at a time — never arm a second entry while one is working.
    if (state.hasOpenPosition || state.hasLiveOrder) {
      return { action: 'HOLD', reason: 'a position or entry is already working' };
    }

    const i = candles.length - 1;
    const last = candles[i];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // One decision per closed 1m bar.
    if (last.time === this.lastBarTime) return { action: 'HOLD', reason: 'bar already evaluated' };

    const hold = (reason) => {
      this.lastBarTime = last.time;
      return { action: 'HOLD', reason };
    };

    if (this.cache.time !== last.time) this.computeContext(candles);

    const { table, zoneAt, atrArr, erArr, emaArr } = this.cache;
    const a = atrArr[i];
    if (!a || !(a > 0)) return hold('no ATR yet on this bar');

    // --- regime + volatility gates --------------------------------------
    const er = erArr[i];
    if (er !== null && er > F.erMax) {
      return hold(`ER ${er.toFixed(2)} > ${F.erMax} — trending, not a range to fade`);
    }
    if (F.minAtrPct > 0 && a / last.close < F.minAtrPct) {
      return hold(`ATR% ${((a / last.close) * 100).toFixed(3)} below the ${(F.minAtrPct * 100).toFixed(2)} floor`);
    }
    const em = emaArr[i];

    // --- look for a zone to fade ----------------------------------------
    const ids = zoneAt[i] || [];
    const prevClose = candles[i - 1].close;
    const prox = F.proximityAtr * a;

    for (const id of ids) {
      const z = table[id];
      if (z.touches < F.minTouches) continue;
      if (F.requireHVN && !z.hvn) continue;
      if (F.minStrength > 0 && zoneStrength(z, i) < F.minStrength) continue;

      // support fade: price is above the zone and drifting down into its top
      // edge. The zone is only valid support while it has never closed BELOW
      // its low; price being above it is the normal state, not a break.
      if (
        z.brokenDownAt === null &&
        prevClose > z.high &&
        last.close > z.high &&
        last.close - z.high <= prox
      ) {
        if (em !== null && last.close <= em) continue; // fade only with the drift
        return this.buildSignal('long', z, last, a, er, i);
      }

      // resistance fade: price is below the zone and drifting up into its
      // bottom edge.
      if (
        z.brokenUpAt === null &&
        prevClose < z.low &&
        last.close < z.low &&
        z.low - last.close <= prox
      ) {
        if (em !== null && last.close >= em) continue;
        return this.buildSignal('short', z, last, a, er, i);
      }
    }

    return hold(`no zone within ${prox.toFixed(1)} pts of the close`);
  }

  buildSignal(side, zone, last, atrV, er, i) {
    const dir = side === 'long' ? 1 : -1;
    const entry = this.snap(side === 'long' ? zone.high : zone.low);
    const rawStop = side === 'long' ? zone.low - F.stopBufAtr * atrV : zone.high + F.stopBufAtr * atrV;
    const stop = this.snap(rawStop);
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return { action: 'HOLD', reason: 'zone edge and stop collapsed to the same price' };

    const target = this.snap(entry + dir * F.targetR * risk);
    if (!(stop > 0) || !(target > 0)) return { action: 'HOLD', reason: 'stop or target is not a valid price' };

    const quantity = this.sizeContracts(entry, stop);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounded to zero contracts' };

    this.lastBarTime = last.time;

    const strength = zoneStrength(zone, i);

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'limit_order', // maker fill at the zone edge
      stopLoss: stop,
      takeProfit: [{ price: target }],
      strategyName: this.name,
      reason:
        `S/R 1m fade ${side}: close ${last.close} drifted into the ` +
        `${side === 'long' ? 'support' : 'resistance'} zone [${zone.low.toFixed(1)}, ${zone.high.toFixed(1)}] ` +
        `(${zone.touches} touches, ${zone.kind}${zone.hvn ? ', HVN shelf' : ''}, strength ${strength.toFixed(1)}), ` +
        `limit ${entry}, stop ${stop}, TP ${target} (${F.targetR}R), ER ${er === null ? 'n/a' : er.toFixed(2)}`,
      meta: {
        exitMode: 'bracket',
        family: 'sr-zone-1m',
        zoneId: zone.id,
        zoneLow: zone.low,
        zoneHigh: zone.high,
        zoneTouches: zone.touches,
        zoneHvn: zone.hvn,
        zoneKind: zone.kind,
        zoneStrength: strength,
        atr: atrV,
        er,
        rMultiple: F.targetR,
        riskPoints: risk,
        validityMinutes: F.entryValidityBars,
      },
    };
  }
}

module.exports = new SrZoneFade1m();
