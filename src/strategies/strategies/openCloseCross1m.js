// "Open Close Cross Strategy R5.1" (TradingView Pine v3, revised by JustUncleL)
// ported to the live engine at the 1-minute resolution.
//
// Front-end model (see backtest/research-occ-cross.js for the study):
//   * SMMA(8) of the close series and SMMA(8) of the open series, both on the
//     1m chart (the script's default "Alternate Resolution" multiplier of 3 only
//     matters when the chart is not 1m; on a 1m feed the strategy resolution is
//     the chart, so this runs at 1m).
//   * LONG  when the close SMMA crosses OVER the open SMMA,
//     SHORT when it crosses UNDER.
//   * the published script ships SL = 0 and TP = 0 (both disabled) and never
//     calls strategy.close, so an opposite cross simply REVERSES the position.
//     This port is deliberately the same: it is an always-in-market flip
//     system with NO stop and NO target. The only exit is the next opposite
//     cross.
//
// The original also uses `security(..., lookahead=barmerge.lookahead_on)` with
// "Delay Open/Close MA" = 0, so on TradingView the cross is read from the
// STILL-FORMING higher-timeframe bar and can repaint. This port reads the last
// CLOSED 1m bar only, which is what can actually be deployed.
//
// WARNING — measured behaviour (7-day BTCUSD backtest): the gross edge is ~0
// and the strategy flips ~236 times a day, so retail fees turn it sharply
// negative. It is wired up because it was asked for; it is NOT registered as
// ACTIVE_STRATEGY, so nothing auto-starts it.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the open/close SMMAs (no look-ahead);
//   2. look for a crossover / crossunder on this bar;
//   3. flat -> enter at market in the signal's direction;
//      holding the other side -> close at market (reduce-only) and let the
//      next cycle open the reverse leg;
//      already holding the signal's side -> stand down.

const MA_LEN = 8;

// The SMMA needs 8 closes plus one prior bar for the cross comparison.
const MIN_BARS = 20;

// ---------------------------------------------------------------------------
// Indicators — identical maths to backtest/research-occ-cross.js
// ---------------------------------------------------------------------------

// Pine's SMMA (a.k.a. ta.rma / "smoothed" MA): the SMA seeds index len-1, then
// v = (v[1] * (len - 1) + src) / len. A null anywhere before the seed stays null.
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
// Strategy
// ---------------------------------------------------------------------------

class OpenCloseCross1m {
  constructor() {
    this.name = 'OpenCloseCross1m';
    this.description =
      'Open Close Cross (TradingView R5.1) on the 1m chart: SMMA(8) of the close crossing SMMA(8) ' +
      'of the open flips the position. An always-in reversal system — no stop, no target, the next ' +
      'opposite cross is the only exit.';
    this.symbol = 'BTCUSD';

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.5;
    this.contractValue = 0.001;
    this.equity = 1000;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    this.fixedContracts = 0;
    this.maxConcurrentPositions = 1;

    // The script's default_qty_type = percent_of_equity, default_qty_value = 10.
    // With no stop there is no risk-per-trade to size from, so this is the
    // sizing rule the original uses.
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.closeMA = null;
    this.openMA = null;
    this.signalSide = null; // 'long' | 'short' — the most recent cross
    this.entryDone = false; // whether that cross has already been acted on
    this.lastReason = '';
  }

  // percent_of_equity sizing (10% of equity notional), floored at the exchange
  // minimum. A fixed size (set from the env) bypasses the maths entirely.
  sizeContracts(entry) {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));

    const price = Number(entry);
    const contractValue = Number(this.contractValue) || 0.001;
    if (!(price > 0)) return Math.max(1, Number(this.minContracts) || 1);

    const notional = (Number(this.equity) || 0) * this.notionalPercent;
    const size = Math.floor(notional / (price * contractValue));
    return Math.max(Number(this.minContracts) || 1, size);
  }

  // Rounds a price to the product's tick size (BTCUSD = 0.5).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  // Rebuilds both SMMAs once per closed bar.
  computeContext(candles) {
    this.closeMA = smma(candles.map((c) => c.close), MA_LEN);
    this.openMA = smma(candles.map((c) => c.open), MA_LEN);
  }

  // Looks for an open/close crossover on the last closed bar. Sets signalSide
  // when one is found; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const c1 = this.closeMA[i];
    const o1 = this.openMA[i];
    const c0 = this.closeMA[i - 1];
    const o0 = this.openMA[i - 1];
    if (c0 == null || o0 == null || c1 == null || o1 == null) {
      return `SMMA(${MA_LEN}) not warmed up on this bar`;
    }

    if (c0 <= o0 && c1 > o1) {
      this.signalSide = 'long';
      this.entryDone = false;
      return `fresh long cross (close ${c1.toFixed(1)} > open ${o1.toFixed(1)})`;
    }

    if (c0 >= o0 && c1 < o1) {
      this.signalSide = 'short';
      this.entryDone = false;
      return `fresh short cross (close ${c1.toFixed(1)} < open ${o1.toFixed(1)})`;
    }

    return 'no open/close cross on this bar';
  }

  // Places one market entry. The original uses strategy.entry (a market order),
  // and an always-in reversal cannot safely rest an unfilled limit, so this
  // stays a market order. No stop/target travels with it — that is the
  // published behaviour (SL = 0, TP = 0).
  buildEntry(side, last) {
    const entry = this.snap(last.close);
    if (!(entry > 0)) return { action: 'HOLD', reason: 'no valid entry price' };

    const quantity = this.sizeContracts(entry);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.entryDone = true;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        `OpenCloseCross ${side}: the close SMMA(${MA_LEN}) crossed ` +
        `${side === 'long' ? 'over' : 'under'} the open SMMA(${MA_LEN}) at ${entry} ` +
        '(market entry, no bracket — the next opposite cross reverses)',
      meta: {
        exitMode: 'reverse',
        family: 'open-close-cross-1m',
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // One cross decision per closed 1m bar. The decision BELOW still runs on
    // every tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.computeContext(candles);
      this.lastBarTime = last.time;
      this.lastReason = this.detectSignal(candles);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding a position -------------------------------------------------
    if (position) {
      // An opposite cross is the reverse leg: close at market, re-enter next.
      if (this.signalSide && position.side && position.side !== this.signalSide) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `reverse ${position.side} -> ${this.signalSide} (${this.lastReason})`,
        };
      }
      // Otherwise the current cross is already the side we hold.
      this.entryDone = true;
      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat ---------------------------------------------------------------
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no cross yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the cross has already been traded' };

    return this.buildEntry(this.signalSide, last);
  }
}

module.exports = new OpenCloseCross1m();
