// "20 years old Turtles strategy" (TradingView Pine v2, by tmr0; idea from
// Curtis Faith's *Way of the Turtle*, 2007) ported to the live engine on the
// 1-MINUTE resolution.
//
// WHAT IT IS
// ----------
// The Turtle breakout, as two independent Donchian channels:
//
//   fast system (20 / 10)            slow system (55 / 20)
//   ------------------------         ------------------------
//   fastL = highest(high, 20)        slowL = highest(high, 55)
//   fastLC = lowest (low , 10)       slowLC = lowest (low , 20)
//   fastS = lowest (low , 20)        slowS = lowest (low , 55)
//   fastSC = highest(high, 10)       slowSC = highest(high, 20)
//
//   enterL1 = high > fastL[1]        enterL2 = high > slowL[1]
//   exitL1  = low <= fastLC[1]       exitL2  = low <= slowLC[1]
//   enterS1 = low  < fastS[1]        enterS2 = low  < slowS[1]
//   exitS1  = high >= fastSC[1]      exitS2  = high >= slowSC[1]
//
//   strategy.entry("fast L", long,  when=enterL1)   strategy.close("fast L", when=exitL1)
//   strategy.entry("fast S", short, when=enterS1)   strategy.close("fast S", when=exitS1)
//   strategy.entry("slow L", long,  when=enterL2)   strategy.close("slow L", when=exitL2)
//   strategy.entry("slow S", short, when=enterS2)   strategy.close("slow S", when=exitS2)
//
// `x[1]` is the value of x on the PREVIOUS bar, so a long entry means the bar's
// HIGH broke the highest HIGH of the ENTER_FAST bars ENDING ON THE PREVIOUS bar
// (the classic 20-bar breakout), and the long exits when the bar's LOW gives
// back below the lowest LOW of the EXIT_FAST prior bars. The slow system is the
// same with the wider look-backs. There is no stop and no target: the opposite
// channel is the only exit — a strategy-managed (signal) exit, not a broker
// bracket.
//
// PORT NOTES / DEVIATIONS FROM THE PINE SOURCE
// --------------------------------------------
// 1. RESOLUTION. The source is "any timeframe"; Turtles run on daily bars
//    historically. This port runs on the engine's 1m feed (candles1m) to match
//    the sibling ports; change the feed key below to run it on another
//    resolution (e.g. candles15m — then set STRATEGY_CANDLES_15M > 0 in .env).
// 2. PYRAMIDING. The source sets `pyramiding = 5`: every further breakout ADDS
//    a unit to the running trade instead of being ignored, up to PYRAMID_MAX
//    units at once. That is ported here — a fresh breakout opens an ADDITIONAL
//    concurrent position rather than being suppressed while one is open. Each
//    unit remembers the system that opened it, so it exits on that system's own
//    channel, exactly as the four `strategy.close` calls imply. The engine's own
//    cap (STRATEGY_MAX_CONCURRENT_POSITIONS, default 4) still applies, so the
//    effective limit is the smaller of PYRAMID_MAX and that.
// 3. SIZING. The source sizes each unit at 1000 cash (default_qty_type=cash);
//    like the sibling ports this uses a pinned lot size (LOTS) so the risk
//    manager's order/position caps stay meaningful.
// 4. FILLS. Signals are read on the last CLOSED 1m bar and entered at market on
//    the next engine cycle. Non-repainting (no `x[1]` look-ahead).
// 5. INVERT_SIGNALS is an addition, not in the source — kept for parity with the
//    other ports here. When it fades a breakout the unit is HELD on the opposite
//    side but still exits on the channel of the LEG that fired (Pine's
//    strategy.close("fast L") closes the fast-L leg whatever it holds), so a
//    faded unit is not stopped out the instant it opens.
//
// To run it: set ACTIVE_STRATEGY = 'TurtlesStrategy' in
// src/strategies/strategyManager.js and restart the server. The instrument comes
// from .env (TRADING_SYMBOL / TRADING_SYMBOLS).

// --- source inputs ---------------------------------------------------------
const ENTER_FAST = 20; // "enter_fast" — fast system breakout look-back
const EXIT_FAST = 10; // "exit_fast"  — fast system trailing channel
const ENTER_SLOW = 55; // "enter_slow" — slow system breakout look-back
const EXIT_SLOW = 20; // "exit_slow"  — slow system trailing channel

// The candle feed this strategy is computed on. Swap to 'candles15m' (and set
// STRATEGY_CANDLES_15M > 0 in .env) to run the Turtles on 15-minute bars.
const CANDLE_FEED = 'candles1m';

// The slow system needs ENTER_SLOW prior bars before its channel exists.
const MIN_BARS = ENTER_SLOW + 1;

// The source's `pyramiding = 5`: how many units the strategy may hold at once.
// The engine adds its own cap (STRATEGY_MAX_CONCURRENT_POSITIONS, default 4), so
// the effective limit is the smaller of the two.
const PYRAMID_MAX = 5;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected.
//   false -> keep trading no matter what the day's P&L is.
const HALT_ON_DAILY_LOSS = false;

// Order size in CONTRACTS (Delta "lots"):
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env.
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, and if that is 0 as well, size
//          from percent_of_equity (10% notional), floored at minContracts.
const LOTS = 1;

// The published (non-faded) mapping, kept as an explicit switch:
//   false -> the rules as written (long on an upside channel break, short on a
//            downside break)
//   true  -> INVERT the signal (the fade).
// The flip is applied to the side we intend to HOLD (signalSide), never to the
// order action — buildEntry still does BUY-for-long / SELL-for-short.
const INVERT_SIGNALS = false;

// ---------------------------------------------------------------------------
// Indicators
//
// `highestPrev`/`lowestPrev` return the extreme over the `len` bars ENDING ON
// THE BAR BEFORE `i` — i.e. exactly Pine's `highest(...)[1]`. Excluding the
// current bar is what keeps the breakout non-repainting.
// ---------------------------------------------------------------------------

function highestPrev(candles, i, len) {
  const start = i - len;
  if (start < 0) return null;
  let best = -Infinity;
  for (let k = start; k < i; k += 1) {
    const h = Number(candles[k] && candles[k].high);
    if (!Number.isFinite(h)) return null;
    if (h > best) best = h;
  }
  return best;
}

function lowestPrev(candles, i, len) {
  const start = i - len;
  if (start < 0) return null;
  let best = Infinity;
  for (let k = start; k < i; k += 1) {
    const l = Number(candles[k] && candles[k].low);
    if (!Number.isFinite(l)) return null;
    if (l < best) best = l;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class TurtlesStrategy {
  constructor() {
    this.name = 'TurtlesStrategy';
    this.description =
      `The Turtles breakout (tmr0 / Curtis Faith) on the 1m chart: two Donchian channels — ` +
      `fast ${ENTER_FAST}/${EXIT_FAST} and slow ${ENTER_SLOW}/${EXIT_SLOW}. A bar's high breaking the ` +
      'prior channel high buys; a low breaking the prior channel low sells; each unit exits on ' +
      `the opposite channel of the system that opened it, and up to ${PYRAMID_MAX} units pyramid on ` +
      'further breakouts. No stop and no target.';
    // Left blank on purpose: the engine sets this to the tracked symbol on start
    // (see tradingEngine.applyProductSettings), so the instrument is configured
    // in one place — .env — and can never disagree with the market feed.
    this.symbol = null;

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.05;
    this.contractValue = 0.01;
    this.equity = 1000;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    // Explicit lot size — see the LOTS constant above.
    this.fixedContracts = Math.max(0, Math.floor(LOTS));
    // How many concurrent positions may run at once. The engine overwrites this
    // from config on start (see applyProductSettings) so the strategy and the
    // order gate never disagree — see header note 2.
    this.maxConcurrentPositions = Math.max(1, PYRAMID_MAX);
    this.leverage = 1;

    // Only used when LOTS is 0 (percent_of_equity fallback).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance per tracked symbol, so each instrument keeps its own
  // last-bar and signal state.
  newInstance() {
    return new TurtlesStrategy();
  }

  reset() {
    this.lastBarTime = 0; // last closed bar already evaluated
    // Exit flags for the last closed bar, per system.
    this.exitLong = { fast: false, slow: false };
    this.exitShort = { fast: false, slow: false };
    this.signalSide = null; // 'long' | 'short' — the side the last signal wants to hold
    this.pendingSystem = null; // 'fast' | 'slow' — the system of that signal
    this.pendingLegSide = null; // 'long' | 'short' — that leg's published side (owns its exit)
    this.pendingEntrySystem = null; // 'fast' | 'slow' — the system of the entry last sent
    this.pendingEntrySide = null; // 'long' | 'short' — the side of that entry (as held)
    this.pendingEntryLeg = null; // 'long' | 'short' — that entry's leg side (owns its exit)
    this.entryDone = false; // whether that signal has already been acted on
    // The open units, OLDEST FIRST. Each holds the system that opened it (which
    // owns its exit channel), the side it is held on, the leg's published side
    // its exit channel belongs to, and whether that channel has already fired.
    // The engine holds at most `maxConcurrentPositions` of them — this ledger is
    // the strategy's own view of that stack (see header note 2).
    this.units = [];
    this.lastReason = '';
  }

  // percent_of_equity sizing (10% of equity notional), floored at the exchange
  // minimum. An explicit lot size (LOTS, else STRATEGY_FIXED_CONTRACTS) bypasses
  // the maths entirely.
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

  // Rounds a price to the product's tick size (ETHUSD = 0.05).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  // Formats a price for log/reason strings at the product's own precision.
  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  // Evaluates the eight channel conditions on the last CLOSED bar (index i) and
  // decides the side the signal wants to hold, in the source's declaration
  // order: fast L, fast S, slow L, slow S.
  computeSignal(candles) {
    const i = candles.length - 1;
    const last = candles[i];

    const fastHigh = highestPrev(candles, i, ENTER_FAST);
    const fastLow = lowestPrev(candles, i, EXIT_FAST);
    const fastLowEntry = lowestPrev(candles, i, ENTER_FAST);
    const fastHighExit = highestPrev(candles, i, EXIT_FAST);

    const slowHigh = highestPrev(candles, i, ENTER_SLOW);
    const slowLow = lowestPrev(candles, i, EXIT_SLOW);
    const slowLowEntry = lowestPrev(candles, i, ENTER_SLOW);
    const slowHighExit = highestPrev(candles, i, EXIT_SLOW);

    if (
      fastHigh == null ||
      fastLow == null ||
      fastLowEntry == null ||
      fastHighExit == null ||
      slowHigh == null ||
      slowLow == null ||
      slowLowEntry == null ||
      slowHighExit == null
    ) {
      return 'channel not warmed up on this bar';
    }

    const high = Number(last.high);
    const low = Number(last.low);

    const enterL1 = high > fastHigh;
    const exitL1 = low <= fastLow;
    const enterS1 = low < fastLowEntry;
    const exitS1 = high >= fastHighExit;

    const enterL2 = high > slowHigh;
    const exitL2 = low <= slowLow;
    const enterS2 = low < slowLowEntry;
    const exitS2 = high >= slowHighExit;

    // Exit flags are always recorded so each open unit can be closed by the
    // channel of the system that opened it.
    this.exitLong = { fast: exitL1, slow: exitL2 };
    this.exitShort = { fast: exitS1, slow: exitS2 };

    let side = null;
    let system = null;
    let detail = '';
    if (enterL1) {
      side = 'long';
      system = 'fast';
      detail = `high ${this.fmt(high)} > prior ${ENTER_FAST}-bar high ${this.fmt(fastHigh)}`;
    } else if (enterS1) {
      side = 'short';
      system = 'fast';
      detail = `low ${this.fmt(low)} < prior ${ENTER_FAST}-bar low ${this.fmt(fastLowEntry)}`;
    } else if (enterL2) {
      side = 'long';
      system = 'slow';
      detail = `high ${this.fmt(high)} > prior ${ENTER_SLOW}-bar high ${this.fmt(slowHigh)}`;
    } else if (enterS2) {
      side = 'short';
      system = 'slow';
      detail = `low ${this.fmt(low)} < prior ${ENTER_SLOW}-bar low ${this.fmt(slowLowEntry)}`;
    }

    // The leg's PUBLISHED side, kept before the fade: the exit channel belongs
    // to the leg, not to the side we end up holding (Pine's
    // strategy.close("fast L") closes the fast-L leg whatever we hold).
    const legSide = side;

    if (side && INVERT_SIGNALS) {
      side = side === 'long' ? 'short' : 'long';
      detail += ' (inverted)';
    }

    if (side) {
      this.signalSide = side;
      this.pendingSystem = system;
      this.pendingLegSide = legSide;
      this.entryDone = false;
      return `${system} ${side} breakout: ${detail} -> hold ${side}`;
    }
    return 'no channel break on this bar';
  }

  // Keeps the unit ledger the same size as what is actually open, oldest first.
  // A shrunken book is trimmed from the newest end (the engine closes the newest
  // position unless an id is given); a grown one is tagged with the system and
  // side of the entry that was last sent, so the new unit exits on the right
  // channel.
  syncUnits(positions) {
    const count = positions.length;
    while (this.units.length > count) this.units.pop();
    while (this.units.length < count) {
      this.units.push({
        system: this.pendingEntrySystem || 'fast',
        side: this.pendingEntrySide || null,
        leg: this.pendingEntryLeg || this.pendingEntrySide || null,
        exit: false,
      });
      this.pendingEntrySystem = null;
      this.pendingEntrySide = null;
      this.pendingEntryLeg = null;
    }
  }

  // A unit exits on the channel of the leg that opened it. The flag LATCHES:
  // once the channel has been given back the unit is due out, even if a later
  // bar trades back inside the channel before the close has gone through.
  latchExits() {
    this.units.forEach((unit) => {
      const exits = unit.leg === 'short' ? this.exitShort : this.exitLong;
      if (exits[unit.system]) unit.exit = true;
    });
  }

  // Closes the OLDEST unit that is due out. Its position id travels with the
  // signal so the engine closes THAT unit rather than its newest-first default —
  // that is what lets a fast unit exit on the fast channel while a slow unit is
  // still held.
  buildExit(positions) {
    for (let i = 0; i < this.units.length; i += 1) {
      const unit = this.units[i];
      if (!unit.exit) continue;

      const channel = unit.system === 'fast' ? EXIT_FAST : EXIT_SLOW;
      const position = positions[i] || null;
      const positionId = position && position._id ? String(position._id) : undefined;

      // Drop it from the ledger now, in place, so the stack stays aligned with
      // the book once this close lands (syncUnits only sees counts, and the
      // engine's newest-first default would otherwise pop the wrong end).
      this.units.splice(i, 1);

      return {
        action: 'CLOSE',
        symbol: this.symbol,
        // Present in paper mode (local rows); live positions are netted per
        // product, so the engine then falls back to the newest-first close.
        positionId,
        strategyName: this.name,
        reason:
          `Turtles ${unit.system} exit: closing the ${unit.side} unit on the ${channel}-bar ` +
          `${unit.side === 'long' ? 'low' : 'high'} channel (${this.lastReason})`,
      };
    }
    return null;
  }

  // Places one market entry. The source uses strategy.entry (a market order).
  // No stop and no target travel with the order — the opposite channel of the
  // system that opened the unit is its only exit (an exitMode of 'signal',
  // managed by this strategy, not a resting broker bracket).
  buildEntry(side, price) {
    const entry = this.snap(price);
    if (!(entry > 0)) return { action: 'HOLD', reason: 'no valid entry price' };

    const quantity = this.sizeContracts(entry);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    const system = this.pendingSystem || 'fast';

    this.entryDone = true;
    // Remembered so the unit that this fill opens is tagged with its system,
    // held side and leg, and exits on the right channel (see syncUnits).
    this.pendingEntrySystem = system;
    this.pendingEntrySide = side;
    this.pendingEntryLeg = this.pendingLegSide || side;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        `Turtles ${system} ${side}: ${this.lastReason}` +
        (system === 'fast' ? ` (exit on the ${EXIT_FAST}-bar channel)` : ` (exit on the ${EXIT_SLOW}-bar channel)`) +
        ` at ${this.fmt(entry)} — market entry, no stop, the opposite channel exits`,
      meta: {
        // The exits are strategy-driven (CLOSE actions), not a resting bracket.
        exitMode: 'signal',
        family: 'turtles',
        // Carried into the risk context so the daily-loss cap can be opted out
        // of for this strategy (see HALT_ON_DAILY_LOSS above).
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData[CANDLE_FEED]) ? marketData[CANDLE_FEED] : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed candle yet' };

    // One signal decision per closed bar. The decision BELOW still runs on every
    // tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.lastBarTime = last.time;
      this.lastReason = this.computeSignal(candles);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    this.syncUnits(positions);
    this.latchExits();

    // --- exits first, so risk comes off before another unit goes on --------
    const exit = this.buildExit(positions);
    if (exit) return exit;

    // --- entries (pyramiding) ----------------------------------------------
    // A fresh breakout adds another unit instead of being suppressed while one
    // is open — the source's `pyramiding = 5`.
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (this.units.length >= PYRAMID_MAX) {
      return {
        action: 'HOLD',
        reason: `pyramid full (${this.units.length}/${PYRAMID_MAX}) — the engine cap may be lower; ${this.lastReason}`,
      };
    }
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no signal yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the signal has already been traded' };

    const price = Number(marketData.price) || Number(last.close) || 0;
    return this.buildEntry(this.signalSide, price);
  }
}

module.exports = new TurtlesStrategy();
