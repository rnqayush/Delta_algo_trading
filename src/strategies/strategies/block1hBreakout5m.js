// 1-hour block breakout on the 5-minute chart.
//
// The clock is cut into 1-hour blocks ANCHORED TO SERVER START: start the server
// at 6:43 and the first block runs 6:40-7:40, the next 7:40-8:40, and so on
// every 1h from there, instead of following UTC midnight.
//
//   1. The FIRST 5m candle of a block is the level candle (6:40-6:45). Once it
//      has closed, its high and low are the breakout level for the rest of that
//      block.
//   2. A later 5m candle in the same block that CLOSES above the high goes long;
//      one that CLOSES below the low goes short. A close inside the level is
//      ignored.
//   3. The stop and the target are set from the MONEY at stake, not from the
//      level: a stop-out costs `riskPercent` of the invested equity and the
//      target pays `rewardPercent` of it. With a fixed size the price
//      distances are derived from the account — e.g. 5% of $11.4 on one
//      0.001-BTC contract is 570 points of stop and 1% is 114 points of
//      target. `maxStopPoints` still acts as a ceiling on the stop distance,
//      so a risk percentage that needs more than 300 points is capped there.
//   4. One trade per block, then the block is done (no re-arming that block).
//
// Only one bracket is ever working: while a position or a resting entry exists
// the strategy stands down, so the slots never stack.
//
// The engine does the rest — it places the entry and rests the stop
// (stop_market_order) and the target (take_profit_order) on Delta as reduce-only
// orders, so the bracket survives this process going down.

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

class Block1hBreakout5m {
  constructor() {
    this.name = 'Block1hBreakout5m';
    this.description =
      '1h blocks anchored to server start, 5m chart: the first 5m candle of each block sets ' +
      'the level, a 5m close beyond it enters, stop = 5% of invested equity, target = 1%.';
    this.symbol = 'BTCUSD';

    // --- block geometry: 1h blocks, level taken from the block's first 5m candle ---
    this.blockHours = 1;
    this.blockMs = this.blockHours * ONE_HOUR_MS;
    this.barMs = FIVE_MIN_MS;

    // --- risk / reward, measured in money on the invested equity ---
    // Reversed R:R: the stop is the wide side of the bracket, the target the
    // narrow one. A stop-out costs 5% of the invested equity, the target pays 1%.
    this.riskPercent = 0.05; // a stop-out costs 5% of the invested equity
    this.rewardPercent = 0.01; // the target pays 1% of the invested equity
    // Ceiling on the derived stop distance, in price points.
    this.maxStopPoints = 300;

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.5;
    this.contractValue = 0.001;
    this.equity = 1200;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    this.fixedContracts = 0;
    this.maxConcurrentPositions = 1;

    // One signal per closed 5m bar, and only one trade per 1h block.
    this.lastBarTime = 0;
    this.lastTradeBlock = 0;
    // Where the block grid starts: the 5m boundary the server came up in.
    // Re-based on every reset(), i.e. whenever the engine starts.
    this.anchorBlock = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0;
    this.lastTradeBlock = 0;
    this.anchorBlock = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;
  }

  // Money at stake on one trade, in quote currency.
  riskAmount() {
    const equity = Number(this.equity) || 0;
    const percent = Number(this.riskPercent) || 0;
    return equity * percent;
  }

  rewardAmount() {
    const equity = Number(this.equity) || 0;
    const percent = Number(this.rewardPercent) || 0;
    return equity * percent;
  }

  // The position size. Risk-based sizing and money-based brackets are circular
  // (each defines the other), so the size is fixed: STRATEGY_FIXED_CONTRACTS
  // lots when set, otherwise the exchange minimum.
  sizeContracts() {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));
    return Math.max(1, Number(this.minContracts) || 1);
  }

  // How far price may move against `quantity` contracts before `amount` is
  // lost, capped at maxStopPoints. One point on a 0.001-BTC contract is
  // $0.001, so $0.114 of risk on one contract is 114 points.
  stopPoints(amount, quantity) {
    const perPoint = (Number(this.contractValue) || 0.001) * Number(quantity || 0);
    if (!(perPoint > 0)) return 0;
    const raw = Number(amount) / perPoint;
    if (!(raw > 0)) return 0;
    return Math.min(raw, Number(this.maxStopPoints) || 0);
  }

  // Rounds a price to the product's tick size (BTCUSD = 0.5).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles5m) ? marketData.candles5m : [];
    if (candles.length < 2) {
      return { action: 'HOLD', reason: `warming up (${candles.length} 5m candles)` };
    }

    // Single bracket at a time — never arm a second entry while one is working.
    if (state.hasOpenPosition || state.hasLiveOrder) {
      return { action: 'HOLD', reason: 'a position or entry is already working' };
    }

    const i = candles.length - 1;
    const last = candles[i];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 5m candle yet' };

    // One breakout decision per closed 5m bar.
    if (last.time === this.lastBarTime) return { action: 'HOLD', reason: 'bar already evaluated' };

    const hold = (reason) => {
      this.lastBarTime = last.time;
      return { action: 'HOLD', reason };
    };

    // Blocks are anchored to the 5m boundary the server came up in (see reset):
    // start at 6:43 and the first block is 6:40-7:40, the next 7:40-8:40, ...
    const blockIndex = Math.floor((last.time - this.anchorBlock) / this.blockMs);
    if (blockIndex < 0) return hold('waiting for the first block after server start');

    const blockStart = this.anchorBlock + blockIndex * this.blockMs;

    // One trade per block, then the block is done.
    if (this.lastTradeBlock === blockStart) return hold('already traded this block');

    // The level is the block's FIRST 5m candle (6:40-6:45). It has to close
    // before it can be used, so nothing happens during the level candle itself.
    if (last.time <= blockStart) return hold('that candle is the block level candle');

    const level = candles.find((candle) => Number(candle.time) === blockStart);
    if (!level) return hold('the block level candle is not in the feed');

    const levelHigh = Number(level.high);
    const levelLow = Number(level.low);
    if (!(levelHigh > levelLow)) return hold('the level candle has no range');

    const close = Number(last.close);
    let side = null;
    if (close > levelHigh) side = 'long';
    else if (close < levelLow) side = 'short';
    if (!side) return hold(`5m close ${close} inside the level [${levelLow}, ${levelHigh}]`);

    const quantity = this.sizeContracts();
    const riskAmount = this.riskAmount();
    const rewardAmount = this.rewardAmount();
    // Both legs are derived from the money independently, so reversing the two
    // percentages really does reverse the bracket.
    const stopDistance = this.snap(this.stopPoints(riskAmount, quantity));
    const targetDistance = this.snap(this.stopPoints(rewardAmount, quantity));
    if (!(stopDistance > 0)) return hold('could not size the stop from the equity risk');
    if (!(targetDistance > 0)) return hold('could not size the target from the equity reward');

    const dir = side === 'long' ? 1 : -1;
    const entry = this.snap(close);
    const stop = this.snap(entry - dir * stopDistance);
    const target = this.snap(entry + dir * targetDistance);
    if (!(stop > 0) || !(target > 0)) return hold('stop or target is not a valid price');

    this.lastBarTime = last.time;
    this.lastTradeBlock = blockStart;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'market_order', // the breakout is confirmed by the close
      stopLoss: stop,
      takeProfit: [{ price: target }],
      strategyName: this.name,
      reason:
        `${this.blockHours}h block ${side} breakout: 5m close ${close} beyond the ` +
        `level [${levelLow}, ${levelHigh}], risk ${riskAmount.toFixed(2)} on ` +
        `${quantity} contract(s) = ${stopDistance} pts`,
      meta: {
        exitMode: 'bracket',
        family: 'block-breakout',
        blockStart,
        levelHigh,
        levelLow,
        levelRange: levelHigh - levelLow,
        stopDistance,
        targetDistance,
        riskAmount,
        rewardAmount,
        riskPercent: this.riskPercent,
        rewardPercent: this.rewardPercent,
      },
    };
  }
}

module.exports = new Block1hBreakout5m();
