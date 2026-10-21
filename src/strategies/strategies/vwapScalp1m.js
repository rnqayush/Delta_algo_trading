// VWAP 1-minute scalper.
//
// The rules are a straight port of the winning config from
// backtest/research-intraday.js (rank #14):
//
//   vwap stop0.75ATR trail2/be0.5 er>=0.25 adx>=0 sess0-24
//
// How it trades
//   1. The close crosses the session VWAP (dailyVwap). On an UP cross the
//      strategy wants to be long; on a DOWN cross, short.
//   2. It never chases: it rests a MAKER limit entry back AT the VWAP, so the
//      pullback fills it at the level (2 bps instead of taker + slippage).
//   3. The stop is a tight 0.75 x ATR(14) beyond the entry.
//   4. There is no fixed target — the exit is a trailing stop at 2 x ATR, with
//      the stop pulled to breakeven once the trade is 0.5R in profit. That is
//      the "cut losers fast, let winners run" shape.
//   5. A Kaufman Efficiency Ratio gate (ER >= 0.25) skips choppy ranges, so it
//      only arms when the tape is actually moving somewhere.
//
// NOTE: the exit needs the trade manager to trail — see
// positionManager.manageSimplePosition, which reads the plan fields this
// strategy puts in `meta` (trailAtrMult, beAtR, atrPeriod, atrTimeframe).
//
// This strategy only decides WHAT it wants to do. The engine, risk manager and
// order manager place the entry, the stop and the trailing update on the
// exchange.

const { atr, dailyVwap, adx, efficiencyRatio } = require('../../utils/indicators');

class VwapScalp1m {
  constructor() {
    this.name = 'VwapScalp1m';
    this.description =
      'VWAP-cross 1m scalper: rests a maker limit at the session VWAP on a momentum cross, ' +
      '0.75xATR stop, 2xATR trailing exit with breakeven at 0.5R, ER>=0.25 regime gate.';
    this.symbol = 'BTCUSD';

    // --- regime / entry filter ---
    this.erMin = 0.25; // Kaufman efficiency: open only when the tape is trending
    this.adxMin = 0; // extra trend-strength gate (0 = off)
    this.session = [0, 24]; // UTC hours [from, to) it may arm (24 = all day)

    // --- indicator periods (identical to the backtest) ---
    this.atrPeriod = 14;
    this.adxPeriod = 14;
    this.erPeriod = 10;

    // --- stop / exit (identical to the backtest) ---
    this.stopAtrMult = 0.75;
    this.beAtR = 0.5;
    this.trailAtrMult = 2.0;
    this.holdBars = 240; // 4h hard time stop, in 1-minute bars

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.5;
    this.contractValue = 0.001;
    this.equity = 1200;
    this.riskPercent = 0.005;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    this.fixedContracts = 0;
    this.maxConcurrentPositions = 1;

    // The last candle time already acted on, so one cross arms only once.
    this.lastBarTime = 0;
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0;
  }

  // Sizes from the stop distance, exactly like the backtest:
  //   risk-based size, capped by the max-notional exposure ceiling.
  sizeContracts(entry, stop) {
    if (this.fixedContracts > 0) return Math.max(1, Math.floor(this.fixedContracts));

    const distance = Math.abs(Number(entry) - Number(stop));
    const contractValue = Number(this.contractValue) || 0.001;
    const equity = Number(this.equity) || 0;
    if (!(distance > 0) || !(equity > 0)) return 0;

    const byRisk = Math.floor((equity * (Number(this.riskPercent) || 0)) / (distance * contractValue));
    const byNotional = Math.floor((equity * (Number(this.maxNotionalEquity) || 0)) / (Number(entry) * contractValue));
    const size = Math.min(byRisk, byNotional);

    return Math.max(0, size);
  }

  // Rounds a price to the product's tick size (BTCUSD = 0.5).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    const warmup = this.atrPeriod + this.adxPeriod + this.erPeriod;
    if (candles.length <= warmup) {
      return { action: 'HOLD', reason: `warming up (${candles.length} 1m candles)` };
    }

    // Single-position strategy: never arm a second entry while one is working.
    if (state.hasOpenPosition || state.hasLiveOrder) {
      return { action: 'HOLD', reason: 'a position or entry is already working' };
    }

    const i = candles.length - 1;
    const last = candles[i];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed candle yet' };

    // One cross per closed bar.
    if (last.time === this.lastBarTime) return { action: 'HOLD', reason: 'bar already evaluated' };

    const hold = (reason) => {
      this.lastBarTime = last.time;
      return { action: 'HOLD', reason };
    };

    const vwap = dailyVwap(candles);
    const atrSeries = atr(candles, this.atrPeriod);
    const level = vwap[i];
    const prevLevel = vwap[i - 1];
    const atrValue = atrSeries[i];
    if (level == null || prevLevel == null || atrValue == null || atrValue <= 0) {
      return hold('indicators not ready');
    }

    // Optional trading session (UTC hours).
    const hour = new Date(last.time).getUTCHours();
    const sessionOk = this.session[1] >= 24 || (hour >= this.session[0] && hour < this.session[1]);
    if (!sessionOk) return hold(`outside session ${this.session[0]}-${this.session[1]} UTC`);

    // Regime gate — skip ranges.
    const er = efficiencyRatio(candles, this.erPeriod)[i];
    if (this.erMin > 0 && (er == null || er < this.erMin)) {
      return hold(`ER ${er == null ? 'n/a' : er.toFixed(2)} < ${this.erMin} (ranging)`);
    }
    const adxValue = adx(candles, this.adxPeriod)[i];
    if (this.adxMin > 0 && (adxValue == null || adxValue < this.adxMin)) {
      return hold(`ADX ${adxValue == null ? 'n/a' : adxValue.toFixed(1)} < ${this.adxMin}`);
    }

    // Momentum cross of the session VWAP (two most recent closed candles).
    const prevAbove = candles[i - 1].close > prevLevel;
    const currAbove = last.close > level;
    let side = null;
    if (currAbove && !prevAbove) side = 'long';
    else if (!currAbove && prevAbove) side = 'short';
    if (!side) return hold('no VWAP cross');

    this.lastBarTime = last.time;

    const dir = side === 'long' ? 1 : -1;
    const entryLevel = this.snap(level); // the resting maker limit
    const stop = this.snap(entryLevel - dir * this.stopAtrMult * atrValue);
    const quantity = this.sizeContracts(entryLevel, stop);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero' };

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entryLevel,
      orderType: 'limit_order', // maker entry, rested at the VWAP
      stopLoss: stop,
      takeProfit: [], // trailing exit — no fixed target
      strategyName: this.name,
      reason: `VWAP ${side} cross @ ${entryLevel} (ER ${er == null ? 'n/a' : er.toFixed(2)})`,
      meta: {
        exitMode: 'trail',
        family: 'vwap',
        stopAtrMult: this.stopAtrMult,
        trailAtrMult: this.trailAtrMult,
        beAtR: this.beAtR,
        atrPeriod: this.atrPeriod,
        atrTimeframe: '1m',
        timeExitBars: Math.round(this.holdBars / 15), // manager counts 15m bars
        vwapLevel: entryLevel,
      },
    };
  }
}

module.exports = new VwapScalp1m();
