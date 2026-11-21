// RegimeAdaptive1m — a 1-MINUTE strategy that first asks WHAT KIND OF MARKET
// THIS IS, then trades it accordingly.
//
// Most strategies here fire one rule on every bar. This one refuses to: before
// it looks at price it classifies each closed 1m bar into a regime using three
// indicators, and the REGIME — not the raw bar — decides whether the bot
// trades at all, which direction, how big, and when it must stand down.
//
// The three indicators (all from ../../utils/indicators.js, the same maths the
// backtests use):
//   * ADX(14)  -> trend STRENGTH. High = a real trend, low = no direction.
//   * ER(10)   -> Kaufman Efficiency Ratio. ~1 = price travelled in a clean
//                 line (trend), ~0 = it churned and ended where it started
//                 (chop). ADX and ER together are far harder to fool than
//                 either alone: ADX alone calls a wide range a "trend".
//   * ATR(14)  -> VOLATILITY, used only as an on/off gate. Dead tape and news
//                 spikes are both untradeable, for opposite reasons.
// Plus two EMAs of the close (9 / 21) for the trend DIRECTION, and a 20-bar
// Donchian channel for the breakout / fade LEVELS.
//
// The four regimes and what each one does:
//   * trend   -> ADX >= 22 AND ER >= 0.35 AND the EMAs agree on a direction.
//                Trade WITH the trend: a break of the 20-bar extreme is taken
//                in the trend direction (a big trade that runs), at 2x size.
//   * chop    -> ADX <= 18 AND ER <= 0.25. No trend to follow, so fade the
//                edges: sell a push above the 20-bar high, buy a push below the
//                20-bar low, at 1x size, expecting the range to snap back.
//   * no-trade-> ATR/price outside [0.04%, 2%]: too dead or too violent. HOLD,
//                and flatten anything open (a shock invalidates both theses).
//   * mixed   -> the two tests disagree (transition bar). The single most
//                expensive place to trade, so: HOLD and take nothing new.
//
// Exits are managed here (meta.exitMode = 'signal', like HFTV1): a trend trade
// is stopped at 1.5 x ATR and closed the moment the trend is gone (regime left
// 'trend', direction flipped, or price crossed back through the slow EMA); a
// chop fade is stopped at 1 x ATR, targets 1 x ATR, and is time-stopped after
// 10 bars or as soon as the regime leaves 'chop'. No resting bracket is sent.
//
// Bar by bar:
//   1. a new 1m bar closes -> recompute every indicator and re-classify;
//   2. holding  -> run the exit rules for the regime the trade was opened in;
//   3. flat     -> if the regime allows, wait for the 20-bar edge to break and
//                  enter in the regime's direction; otherwise stand down.
//
// To run it: set the instrument in TRADING_SYMBOLS in .env, set ACTIVE_STRATEGY
// = 'RegimeAdaptive1m' in strategyManager.js, and keep STRATEGY_CANDLES_1M >=
// 200 (only the 1m feed is needed — no 5m/15m request is made).

const { atr, adx, efficiencyRatio } = require('../../utils/indicators');

// ---------------------------------------------------------------------------
// Indicator periods
// ---------------------------------------------------------------------------
const EMA_FAST = 9; // fast EMA of the close — near-term trend direction
const EMA_SLOW = 21; // slow EMA of the close — the trend / no-trend line
const ADX_PERIOD = 14; // trend strength
const ER_PERIOD = 10; // Kaufman efficiency ratio (clean trend vs chop)
const ATR_PERIOD = 14; // volatility
const RANGE_BARS = 20; // Donchian lookback for the breakout / fade levels

// ---------------------------------------------------------------------------
// Regime thresholds
// ---------------------------------------------------------------------------
// Trend needs BOTH a strong ADX and a clean ER, otherwise a wide range is
// mistaken for a trend and every breakout is a trap.
const ADX_TREND_MIN = 22;
const ER_TREND_MIN = 0.35;
// Chop needs BOTH weak direction (ADX) and low efficiency (ER).
const ADX_CHOP_MAX = 18;
const ER_CHOP_MAX = 0.25;

// Volatility gate, as ATR/price:
//   below ATR_MIN_PCT -> dead tape: no range to fade and no move to follow;
//   above ATR_MAX_PCT -> news spike: both theses fail and the stop is a mile
//                        away, so stand down.
const ATR_MIN_PCT = 0.0004; // 0.04% of price
const ATR_MAX_PCT = 0.02; // 2% of price

// ---------------------------------------------------------------------------
// Exits (ATR multiples of the ATR frozen at entry) and sizing
// ---------------------------------------------------------------------------
const TREND_STOP_MULT = 1.5; // with-trend breakouts get room to breathe
const CHOP_STOP_MULT = 1.0; // fades are wrong fast or not at all
const CHOP_TARGET_MULT = 1.0; // a fade takes the quick return to the middle
const CHOP_MAX_BARS = 10; // ...and gives up after this many 1m bars

const TREND_SIZE_MULT = 2; // "big trades with the trend"
const CHOP_SIZE_MULT = 1;

// A few bars beyond the longest window (EMA_SLOW + a prior bar, ADX warm-up)
// just guarantee the feed is genuinely warm before the first classification.
const MIN_BARS = 60;

// ---------------------------------------------------------------------------
// Risk switches
// ---------------------------------------------------------------------------
// Stop taking NEW entries once the day has produced this many losses in a row.
// 0 disables the check. An open trade is still managed/exited either way.
const MAX_CONSECUTIVE_LOSSES = 0;

// Daily-loss kill switch for THIS strategy only (carried in meta so the risk
// manager can honour it):
//   true  -> obey RISK_MAX_DAILY_LOSS; a halted day takes no new entries;
//   false -> keep trading no matter what the day's P&L is.
const HALT_ON_DAILY_LOSS = false;

// Order size in CONTRACTS (Delta "lots") before the regime multiplier above:
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env (ignored for this strategy);
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, then to percent_of_equity
//          sizing (10% notional), floored at minContracts.
// Keep it inside RISK_MAX_ORDER_QUANTITY / RISK_MAX_POSITION_SIZE.
const LOTS = 1;

// ---------------------------------------------------------------------------
// Indicators (local)
// ---------------------------------------------------------------------------

// Pine's ta.ema: the SMA seeds index len-1, then v = src * k + v[1] * (1 - k).
// Null anywhere before the seed stays null.
function ema(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;

  const k = 2 / (len + 1);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class RegimeAdaptive1m {
  constructor() {
    this.name = 'RegimeAdaptive1m';
    this.description =
      'Regime-adaptive 1m: classifies each closed bar with ADX(14) + Kaufman ER(10) + ATR(14) ' +
      'into trend / chop / no-trade / mixed, then trades the regime — with-trend 20-bar breakouts ' +
      'at 2x size in a trend, 20-bar edge fades in a chop, nothing in between. ATR-managed exits.';
    // Left blank on purpose: the engine sets this to the tracked instrument on
    // start (see tradingEngine.applyProductSettings), so the symbol comes from
    // .env and can never disagree with the WebSocket feed.
    this.symbol = null;

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.0001;
    this.contractValue = 1;
    this.equity = 1000;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    // Base lot size — the regime multiplier is applied on top (see sizeContracts).
    this.fixedContracts = Math.max(0, Math.floor(LOTS));
    this.maxConcurrentPositions = 1;
    // The account's leverage for the instrument, read from Delta at startup.
    this.leverage = 1;

    // Only used when LOTS is 0 (percent_of_equity fallback).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance carrying the same settings but its own bar/regime state.
  newInstance() {
    return new RegimeAdaptive1m();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.barCount = 0; // closed bars seen (drives the chop time-stop)

    // Indicator series, rebuilt once per closed bar.
    this.emaFast = [];
    this.emaSlow = [];
    this.adx = [];
    this.atr = [];
    this.er = [];
    this.emaSlowLast = null; // slow EMA on the last closed bar

    // Latest indicator readings.
    this.lastAtr = 0; // ATR on the last closed bar (absolute price units)
    this.atrPct = 0; // ATR / price, the volatility gate
    this.rangeHigh = 0; // 20-bar Donchian high — breakout / fade level
    this.rangeLow = 0; // 20-bar Donchian low  — breakout / fade level

    // Regime for the bar that starts now.
    this.regime = 'warming'; // 'trend' | 'chop' | 'no-trade' | 'mixed' | 'warming'
    this.trendDir = null; // 'up' | 'down' | null — EMAs' agreed direction

    // State of the trade this strategy opened.
    this.tradedThisBar = false; // this 1m bar has already produced its trade
    this.tradeMode = null; // 'trend' | 'chop' — which exit rules apply
    this.entryAtr = 0; // ATR frozen at entry, so the stop never moves
    this.entryBarCount = 0; // barCount when the trade opened (chop time-stop)

    this.lastReason = '';
  }

  // Base size before the regime multiplier: explicit lots win, else
  // percent_of_equity (10% notional) floored at the exchange minimum.
  baseSize(entry) {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));

    const price = Number(entry);
    const contractValue = Number(this.contractValue) || 0.001;
    if (!(price > 0)) return Math.max(1, Number(this.minContracts) || 1);

    const notional = (Number(this.equity) || 0) * this.notionalPercent;
    const size = Math.floor(notional / (price * contractValue));
    return Math.max(Number(this.minContracts) || 1, size);
  }

  // The size the regime asks for: a trend trade is the "big" one.
  sizeContracts(entry, mode) {
    const mult = mode === 'trend' ? TREND_SIZE_MULT : CHOP_SIZE_MULT;
    return Math.max(1, Math.floor(this.baseSize(entry) * mult));
  }

  // Formats a price for log/reason strings at the product's own precision.
  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  // Rebuilds every indicator and re-classifies the regime, once per closed bar.
  computeContext(candles) {
    const closes = candles.map((c) => c.close);
    this.emaFast = ema(closes, EMA_FAST);
    this.emaSlow = ema(closes, EMA_SLOW);
    this.adx = adx(candles, ADX_PERIOD);
    this.atr = atr(candles, ATR_PERIOD);
    this.er = efficiencyRatio(candles, ER_PERIOD);

    const i = candles.length - 1;
    const price = Number(closes[i]);

    // 20-bar Donchian channel over the closed bars: one level up, one down.
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = Math.max(0, i - RANGE_BARS + 1); j <= i; j += 1) {
      hi = Math.max(hi, Number(candles[j].high));
      lo = Math.min(lo, Number(candles[j].low));
    }
    this.rangeHigh = hi;
    this.rangeLow = lo;

    const atrLast = Number(this.atr[i]);
    this.lastAtr = Number.isFinite(atrLast) && atrLast > 0 ? atrLast : 0;
    this.atrPct = price > 0 && this.lastAtr > 0 ? this.lastAtr / price : 0;

    const fast = this.emaFast[i];
    const fastPrev = this.emaFast[i - 1];
    const slow = this.emaSlow[i];
    const slowPrev = this.emaSlow[i - 1];
    this.emaSlowLast = slow == null ? null : slow;

    // Trend direction only counts when the EMAs are stacked the right way and
    // the fast EMA is moving that way too; price has to agree.
    let dir = null;
    if (fast != null && slow != null && fastPrev != null && slowPrev != null) {
      if (fast > slow && fast >= fastPrev && price > slow) dir = 'up';
      else if (fast < slow && fast <= fastPrev && price < slow) dir = 'down';
    }
    this.trendDir = dir;

    const adxLast = this.adx[i] == null ? null : Number(this.adx[i]);
    const erLast = this.er[i] == null ? null : Number(this.er[i]);

    // --- the classification itself -----------------------------------------
    let regime;
    if (adxLast == null || erLast == null || !(this.lastAtr > 0)) {
      regime = 'warming'; // an indicator is not warmed up on this bar
    } else if (this.atrPct < ATR_MIN_PCT || this.atrPct > ATR_MAX_PCT) {
      regime = 'no-trade'; // too dead or too violent
    } else if (adxLast >= ADX_TREND_MIN && erLast >= ER_TREND_MIN && dir) {
      regime = 'trend';
    } else if (adxLast <= ADX_CHOP_MAX && erLast <= ER_CHOP_MAX) {
      regime = 'chop';
    } else {
      regime = 'mixed'; // the two tests disagree — the expensive middle
    }
    this.regime = regime;

    const adxText = adxLast == null ? 'n/a' : adxLast.toFixed(1);
    const erText = erLast == null ? 'n/a' : erLast.toFixed(2);
    this.lastReason =
      `regime=${regime} (adx ${adxText}, er ${erText}, atr ${(this.atrPct * 100).toFixed(3)}%` +
      `${dir ? `, dir ${dir}` : ''})`;
  }

  // One market entry, tagged with the regime that produced it so the exit rules
  // know which set to run. Marks the bar as traded so it cannot re-fire.
  buildEntry(side, price, mode, detail) {
    const quantity = this.sizeContracts(price, mode);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.tradedThisBar = true;
    this.tradeMode = mode;
    this.entryAtr = this.lastAtr;
    this.entryBarCount = this.barCount;

    return {
      action: side === 'buy' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      orderType: 'market_order',
      strategyName: this.name,
      reason: `RegimeAdaptive1m ${mode}: ${detail} — ${side === 'buy' ? 'long' : 'short'} ${quantity}x`,
      meta: {
        // The exits are strategy-driven, not a resting bracket.
        exitMode: 'signal',
        family: 'regime-adaptive-1m',
        // Carried into the risk context so the daily-loss cap can be opted out
        // of for this strategy (see HALT_ON_DAILY_LOSS above).
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  // Runs the exit rules for the regime the trade was opened in. Returns a
  // CLOSE signal or a HOLD.
  managePosition(position, price) {
    const entry = Number(position.entryPrice) || 0;
    const long = position.side !== 'short';
    if (!(entry > 0) || !(price > 0)) {
      return { action: 'HOLD', reason: `holding ${position.side}; waiting for a usable mark` };
    }

    // A trade survives a restart without its tag: fall back to the live regime.
    const mode = this.tradeMode || (this.regime === 'chop' ? 'chop' : 'trend');
    const atrEntry = this.entryAtr > 0 ? this.entryAtr : this.lastAtr;

    const close = (reason) => ({
      action: 'CLOSE',
      symbol: this.symbol,
      strategyName: this.name,
      reason,
    });

    if (mode === 'trend') {
      // 1. Hard stop at 1.5 x the entry ATR.
      if (atrEntry > 0) {
        const stop = long ? entry - atrEntry * TREND_STOP_MULT : entry + atrEntry * TREND_STOP_MULT;
        if (long ? price <= stop : price >= stop) {
          return close(
            `trend stop ${this.fmt(stop)} hit: ${position.side} from ${this.fmt(entry)}, mark ${this.fmt(price)}`
          );
        }
      }

      // 2. The trend the trade was riding is gone -> take what is there.
      const trendGone = this.regime !== 'trend' || (long ? this.trendDir !== 'up' : this.trendDir !== 'down');
      const crossedSlow = this.emaSlowLast != null && (long ? price < this.emaSlowLast : price > this.emaSlowLast);
      if (trendGone || crossedSlow) {
        return close(
          `${trendGone ? 'regime left trend' : 'lost the slow EMA'}: ${position.side} from ${this.fmt(entry)}, ` +
          `mark ${this.fmt(price)} — ${this.lastReason}`
        );
      }

      return { action: 'HOLD', reason: `holding with the trend (${position.side}); ${this.lastReason}` };
    }

    // Chop fade: a quick trip back to the middle, with a firm leash.
    if (atrEntry > 0) {
      const stop = long ? entry - atrEntry * CHOP_STOP_MULT : entry + atrEntry * CHOP_STOP_MULT;
      const target = long ? entry + atrEntry * CHOP_TARGET_MULT : entry - atrEntry * CHOP_TARGET_MULT;
      if (long ? price <= stop : price >= stop) {
        return close(
          `chop stop ${this.fmt(stop)} hit: ${position.side} from ${this.fmt(entry)}, mark ${this.fmt(price)}`
        );
      }
      if (long ? price >= target : price <= target) {
        return close(
          `chop target ${this.fmt(target)} reached: ${position.side} from ${this.fmt(entry)}, mark ${this.fmt(price)}`
        );
      }
    }

    const barsHeld = this.barCount - this.entryBarCount;
    if (barsHeld >= CHOP_MAX_BARS) {
      return close(`chop time-stop after ${barsHeld} bars: ${position.side} from ${this.fmt(entry)}, mark ${this.fmt(price)}`);
    }
    if (this.regime !== 'chop') {
      return close(`regime left chop: ${position.side} from ${this.fmt(entry)}, mark ${this.fmt(price)} — ${this.lastReason}`);
    }

    return { action: 'HOLD', reason: `holding the range fade (${position.side}); ${this.lastReason}` };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // One classification per closed 1m bar; the decisions below still run on
    // every tick so exits are acted on without waiting for the next bar.
    if (last.time !== this.lastBarTime) {
      this.lastBarTime = last.time;
      this.barCount += 1;
      this.tradedThisBar = false;
      this.computeContext(candles);
    }

    // The live mark is what entries and exits really happen at; the closed
    // bar's close is only a fallback so the value is never missing.
    const price = Number(marketData.price) || Number(last.close) || 0;

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding: hand over to the regime's exit rules ----------------------
    if (position) return this.managePosition(position, price);

    // --- flat: clear the per-trade tags -------------------------------------
    this.tradeMode = null;
    this.entryAtr = 0;
    this.entryBarCount = 0;

    if (price <= 0) return { action: 'HOLD', reason: 'no live price' };
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (this.tradedThisBar) return { action: 'HOLD', reason: 'this 1m bar has already traded' };

    // --- gates: the days/regimes when we refuse to trade at all -------------
    const daily = marketData.daily || {};
    const consecutiveLosses = Number(daily.consecutiveLosses) || 0;
    if (MAX_CONSECUTIVE_LOSSES > 0 && consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      return {
        action: 'HOLD',
        reason: `standing down: ${consecutiveLosses} losses in a row (max ${MAX_CONSECUTIVE_LOSSES})`,
      };
    }
    if (HALT_ON_DAILY_LOSS && daily.halted) {
      return { action: 'HOLD', reason: 'standing down: the daily loss cap is hit' };
    }

    if (this.regime === 'warming') return { action: 'HOLD', reason: 'indicators not warmed up on this bar' };
    if (this.regime === 'no-trade') {
      return { action: 'HOLD', reason: `standing down: volatility off the band; ${this.lastReason}` };
    }
    if (this.regime === 'mixed') {
      return { action: 'HOLD', reason: `standing down: trend and chop tests disagree; ${this.lastReason}` };
    }

    // --- trend: take the breakout WITH the trend, at 2x size ----------------
    if (this.regime === 'trend') {
      const up = this.trendDir === 'up';
      const broke = up ? price > this.rangeHigh : price < this.rangeLow;
      if (!broke) {
        return {
          action: 'HOLD',
          reason: `trend ${this.trendDir}: waiting for a ${up ? 'close above ' + this.fmt(this.rangeHigh) : 'close below ' + this.fmt(this.rangeLow)}; ${this.lastReason}`,
        };
      }
      const level = up ? this.rangeHigh : this.rangeLow;
      return this.buildEntry(
        up ? 'buy' : 'sell',
        price,
        'trend',
        `${this.trendDir}trend broke the 20-bar ${up ? 'high' : 'low'} ${this.fmt(level)}`
      );
    }

    // --- chop: fade the range edges, at 1x size -----------------------------
    if (price > this.rangeHigh) {
      return this.buildEntry('sell', price, 'chop', `range top ${this.fmt(this.rangeHigh)} stretched — fading back`);
    }
    if (price < this.rangeLow) {
      return this.buildEntry('buy', price, 'chop', `range bottom ${this.fmt(this.rangeLow)} stretched — fading back`);
    }

    return {
      action: 'HOLD',
      reason: `chop: price inside ${this.fmt(this.rangeLow)}–${this.fmt(this.rangeHigh)}, no edge yet`,
    };
  }
}

module.exports = new RegimeAdaptive1m();
