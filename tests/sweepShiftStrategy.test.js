// Unit tests for the Sweep & Shift (S&S-15) strategy.
//
// The strategy is pure — it only turns closed candles into a plan — so these
// tests need no database and no network.

const { SweepShiftStrategy, helpers } = require('../src/strategies/strategies/sweepShiftStrategy');
const { isValidSignal, normalizeSignal } = require('../src/utils/helpers');

// Builds a candle list from [open, high, low, close] rows with increasing times.
function toCandles(rows, stepSeconds) {
  return rows.map(([open, high, low, close], i) => ({
    time: 1700000000 + i * stepSeconds,
    open,
    high,
    low,
    close,
    volume: 10,
  }));
}

// A hand-built 15m series that ends in a sweep -> BOS -> retest setup:
// a cluster of lower swing highs, a swing low at 250 that gets swept, then a
// displacement candle closing back above 251.5 (the broken structure).
const BULL_15M = toCandles(
  [
    [258.0, 258.6, 257.6, 258.2],
    [258.2, 259.0, 257.9, 258.6],
    [258.6, 259.6, 258.3, 259.2],
    [259.2, 260.0, 258.8, 259.6],
    [259.6, 260.6, 259.3, 260.2],
    [260.2, 261.0, 259.8, 260.6],
    [260.6, 261.6, 260.3, 261.2],
    [261.2, 262.2, 260.8, 261.8],
    [261.8, 264.5, 261.5, 264.0], // swing high 264.5
    [264.0, 264.0, 262.0, 262.4],
    [262.4, 262.6, 261.3, 261.6],
    [261.6, 261.8, 261.0, 261.4], // swing low 261.0
    [261.4, 262.2, 261.2, 261.9],
    [261.9, 262.4, 261.5, 262.2],
    [262.2, 262.5, 261.9, 262.1], // swing high 262.5
    [262.1, 262.3, 260.8, 261.0],
    [261.0, 261.2, 258.4, 258.8],
    [258.8, 259.0, 258.0, 258.2], // swing low 258.0
    [258.6, 259.4, 258.3, 259.0],
    [259.0, 259.3, 258.7, 259.2],
    [259.2, 259.5, 258.9, 259.1], // swing high 259.5
    [259.1, 259.3, 256.8, 257.2],
    [257.2, 257.4, 254.6, 255.0],
    [255.0, 255.2, 254.0, 254.4], // swing low 254.0
    [254.8, 255.8, 254.5, 255.4],
    [255.4, 256.5, 255.1, 256.0],
    [256.0, 257.5, 255.8, 257.2], // swing high 257.5 (nearest opposing liquidity)
    [257.2, 257.4, 254.8, 255.2],
    [255.2, 255.4, 250.6, 251.0],
    [251.0, 251.3, 250.0, 250.5], // swing low 250.0 — the liquidity that gets swept
    [250.8, 251.2, 250.4, 251.0],
    [251.0, 251.4, 250.7, 251.2],
    [251.2, 251.5, 250.9, 251.3], // swing high 251.5 — the BOS level
    [251.3, 251.4, 250.6, 250.9],
    [250.9, 251.0, 250.3, 250.5],
    [250.5, 250.7, 250.1, 250.3],
    [250.3, 250.5, 250.05, 250.15],
    [250.15, 250.9, 249.5, 250.7], // sweep: pierces 250.0 and reclaims it
    [250.5, 254.5, 250.4, 254.0], // displacement close above 251.5
    [254.0, 254.4, 253.8, 254.3],
  ],
  900
);

// A 1H series in a clean uptrend (higher highs and higher lows) so the
// higher-timeframe filter is BULLISH. Its swing lows all sit below the 15m
// entry, so the only opposing liquidity comes from the 15m swing highs.
const BULL_1H = toCandles(
  [
    [246, 247, 245, 246.5],
    [246.5, 248.5, 246.2, 248],
    [248, 250, 247.8, 249.5], // swing high 250
    [249.5, 249.6, 246.5, 247],
    [247, 247.2, 244.8, 245.2],
    [245.2, 245.5, 244, 244.6], // swing low 244
    [244.6, 246.5, 244.4, 246],
    [246, 248.5, 245.8, 248],
    [248, 252, 247.8, 251.5], // swing high 252
    [251.5, 251.6, 248.5, 249],
    [249, 249.2, 246.8, 247.2],
    [247.2, 247.5, 246, 246.5], // swing low 246
    [246.5, 248.5, 246.3, 248],
    [248, 250, 247.8, 249.5],
    [249.5, 258, 249.2, 257.5], // swing high 258
    [257.5, 257.6, 254.5, 255],
    [255, 255.2, 251.2, 251.6],
    [251.6, 251.9, 250.5, 251], // swing low 250.5
    [251, 252.5, 250.8, 252.2],
    [252.2, 253, 251.5, 252.8],
  ],
  3600
);

const TICKER = { price: 254.3 };

describe('SweepShiftStrategy helpers', () => {
  it('normalises candles: numbers, sorted by time, drops empty rows', () => {
    const candles = helpers.normalizeCandles([
      { time: 2, open: '2', high: '3', low: '1', close: '2.5' },
      { time: 1, open: '1', high: '2', low: '0.5', close: '1.5' },
      { time: 3, open: '0', high: '0', low: '0', close: '0' },
    ]);

    expect(candles).toHaveLength(2);
    expect(candles[0].time).toBe(1);
    expect(candles[0].close).toBe(1.5);
    expect(typeof candles[0].close).toBe('number');
  });

  it('only confirms a swing once two candles have closed on each side', () => {
    const candles = [
      { time: 0, open: 7.5, high: 10, low: 5, close: 7.5 },
      { time: 1, open: 9, high: 12, low: 6, close: 9 },
      { time: 2, open: 13.5, high: 20, low: 7, close: 13.5 },
      { time: 3, open: 9.5, high: 15, low: 4, close: 9.5 },
      { time: 4, open: 11, high: 14, low: 8, close: 11 },
      { time: 5, open: 11, high: 13, low: 9, close: 11 },
      { time: 6, open: 11, high: 12, low: 10, close: 11 },
    ];

    expect(helpers.swingHighs(candles).map((s) => s.price)).toEqual([20]);
    expect(helpers.swingLows(candles).map((s) => s.price)).toEqual([4]);
  });

  it('measures volatility as the mean absolute body', () => {
    const body = helpers.avgBody([
      { open: 0, close: 1 },
      { open: 0, close: 2 },
      { open: 0, close: 3 },
    ]);

    expect(body).toBe(2);
  });

  it('clusters two nearby swings into one liquidity level', () => {
    const levels = helpers.liquidityLevels(
      [
        { index: 0, price: 100, type: 'LOW' },
        { index: 1, price: 100.1, type: 'LOW' },
      ],
      'LONG',
      1000
    );

    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ price: 100, touches: 2, strength: 'CLUSTER' });
  });

  it('keeps only the levels on the tradeable side of price', () => {
    const levels = helpers.liquidityLevels(
      [
        { index: 0, price: 90, type: 'LOW' },
        { index: 1, price: 110, type: 'LOW' },
      ],
      'LONG',
      100
    );

    expect(levels.map((l) => l.price)).toEqual([90]);
  });

  it('detects a single-candle sweep that reclaims the level', () => {
    const candles = [
      { time: 0, open: 100, high: 101, low: 99.5, close: 100 },
      { time: 1, open: 100, high: 100.5, low: 98.5, close: 99.5 },
    ];

    expect(helpers.detectSweep(candles, 99, 'LONG', 1)).toEqual({ se: 98.5, index: 1 });
  });

  it('requires displacement for a break of structure', () => {
    const candles = [
      { time: 0, open: 100, high: 100.5, low: 99.5, close: 100.1 },
      { time: 1, open: 100.1, high: 103, low: 100, close: 102.8 },
    ];

    expect(helpers.detectBOS(candles, 101, 0, 'LONG', 1)).toBe(candles[1]);
    expect(helpers.detectBOS(candles, 104, 0, 'LONG', 1)).toBeNull();
  });

  it('flags a compressed, low-range market', () => {
    const flat = Array.from({ length: 5 }, (_, i) => ({
      time: i,
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100,
    }));

    expect(helpers.marketFlags(flat, { price: 100 }, 'BULLISH')).toContain('COMPRESSION');
  });

  it('reads a higher-timeframe bias from the 1H swings', () => {
    expect(helpers.htfBias(helpers.normalizeCandles(BULL_1H))).toBe('BULLISH');
    expect(helpers.htfBias([])).toBe('NONE');
  });

  it('scores a textbook setup at the top of the range', () => {
    const score = helpers.scoreTrade({
      htf: 'ALIGNED',
      sweepStrength: 'CLUSTER',
      rejection: 'STRONG',
      bos: 'STRONG',
      rr: 3,
      room: true,
      softFlag: false,
    });

    expect(score).toBe(10);
  });
});

describe('SweepShiftStrategy.evaluate', () => {
  let strategy;

  beforeEach(() => {
    strategy = new SweepShiftStrategy();
  });

  it('exposes a name and is stateless', () => {
    expect(strategy.getName()).toBe('SweepShift-15');
    expect(strategy.reset()).toBeUndefined();
  });

  it('holds when there is no price', () => {
    expect(strategy.evaluate({}, {}).action).toBe('HOLD');
  });

  it('holds when the daily risk limit has been reached', () => {
    expect(strategy.evaluate({ ticker: TICKER, daily: { halted: true } }, {}).action).toBe('HOLD');
    expect(strategy.evaluate({ ticker: TICKER, daily: { tradesToday: 4 } }, {}).action).toBe('HOLD');
    expect(
      strategy.evaluate({ ticker: TICKER, daily: { consecutiveLosses: 2 } }, {}).action
    ).toBe('HOLD');
  });

  it('holds while a position or an entry order is already live', () => {
    const market = { ticker: TICKER, candles15m: BULL_15M, candles1h: BULL_1H };

    expect(strategy.evaluate(market, { hasOpenPosition: true }).action).toBe('HOLD');
    expect(strategy.evaluate(market, { hasLiveOrder: true }).action).toBe('HOLD');
  });

  it('holds until there is enough closed history', () => {
    const signal = strategy.evaluate({
      ticker: TICKER,
      candles15m: BULL_15M.slice(-5),
      candles1h: BULL_1H,
    });

    expect(signal.action).toBe('HOLD');
    expect(signal.reason).toMatch(/not enough/i);
  });

  it('produces a full long plan from a sweep + shift setup', () => {
    const signal = strategy.evaluate({
      ticker: TICKER,
      candles15m: BULL_15M,
      candles1h: BULL_1H,
      daily: {},
    });

    expect(signal.action).toBe('BUY');
    expect(signal.symbol).toBe('BTCUSD');
    expect(signal.orderType).toBe('limit_order');
    expect(signal.quantity).toBeGreaterThan(0);

    // Entry, structure stop and the two partial targets.
    expect(signal.stopLoss).toBeLessThan(signal.price);
    expect(signal.takeProfit).toHaveLength(2);
    expect(signal.takeProfit[0]).toMatchObject({ percent: 40 });
    expect(signal.takeProfit[1]).toMatchObject({ percent: 30 });
    expect(signal.takeProfit[0].price).toBeGreaterThan(signal.price);

    // The plan the trade manager needs.
    expect(signal.meta.side).toBe('LONG');
    expect(signal.meta.bosLevel).toBe(251.5);
    expect(signal.meta.sweepExtreme).toBe(249.5);
    expect(signal.meta.score).toBeGreaterThanOrEqual(7);
    expect(signal.meta.rr).toBeGreaterThanOrEqual(2);

    // Risk stays inside the per-trade cap.
    expect(signal.meta.riskAmount).toBeLessThanOrEqual(strategy.equity * strategy.maxRiskPercent);
  });

  it('returns a signal the execution layer accepts and keeps the bracket intact', () => {
    const signal = strategy.evaluate({
      ticker: TICKER,
      candles15m: BULL_15M,
      candles1h: BULL_1H,
    });

    expect(isValidSignal(signal).valid).toBe(true);

    const normalized = normalizeSignal(signal);
    expect(normalized.action).toBe('BUY');
    expect(normalized.orderType).toBe('limit_order');
    expect(normalized.stopLoss).toBe(signal.stopLoss);
    expect(normalized.takeProfit).toEqual(signal.takeProfit);
    expect(normalized.meta.bosLevel).toBe(signal.meta.bosLevel);
  });

  it('refuses the trade when the notional cap makes the size impossible', () => {
    const tiny = new SweepShiftStrategy({ maxNotionalEquity: 0.0001 });
    const signal = tiny.evaluate({
      ticker: TICKER,
      candles15m: BULL_15M,
      candles1h: BULL_1H,
    });

    expect(signal.action).toBe('HOLD');
  });
});

describe('SweepShiftStrategy.sizePosition', () => {
  it('sizes so a filled stop costs equity x riskPercent', () => {
    const strategy = new SweepShiftStrategy({
      equity: 1000,
      riskPercent: 0.005,
      contractValue: 1,
      maxNotionalEquity: 3,
    });

    const sizing = strategy.sizePosition({ entry: 100, risk: 2 });

    expect(sizing.riskAmount).toBe(5);
    expect(sizing.quantity).toBe(250); // 5 / 2 = 2.5 BTC -> 250 one-dollar contracts
  });

  it('caps risk at maxRiskPercent even if riskPercent is higher', () => {
    const strategy = new SweepShiftStrategy({ equity: 1000, riskPercent: 0.5, maxRiskPercent: 0.01 });

    expect(strategy.sizePosition({ entry: 100, risk: 2 }).riskAmount).toBe(10);
  });

  it('returns null when the notional would exceed the multiple of equity', () => {
    const strategy = new SweepShiftStrategy({ equity: 1000, riskPercent: 0.005, maxNotionalEquity: 3 });

    expect(strategy.sizePosition({ entry: 100000, risk: 2 })).toBeNull();
  });
});
