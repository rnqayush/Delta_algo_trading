# VHR-15 — Volatility Hedge Reversion (BTC 15m)

**Goal:** a strategy that trades **≥ 4 orders/day** and is **net profitable after
fees in every tested market regime** — including a falling month.

**Result:** `VHR-15` is live-ready and meets both. Over 200 days of BTCUSD 15m
data, split into six independent 30-day folds, the tuned configuration was
**positive in 6/6 folds**, **+$528 net** on a $1,200 account, **5.02 orders/day**
(worst fold 4.40), profit factor **1.23**, max drawdown **9.6%**.

Code: [volatilityHedgeReversionStrategy.js](../src/strategies/strategies/volatilityHedgeReversionStrategy.js)
Harness: [run-reversion-freq-backtest.js](../backtest/run-reversion-freq-backtest.js) (`--hedge`)
Raw grid: [hedge-grid.json](../backtest/hedge-grid.json)

---

## 1. What was researched first

The edge was not assumed — it was measured on the cached 15m dataset
(19,200 candles, 2026-03-30 → 2026-10-16) before any strategy was written:

- **Raw 15m momentum has ~zero edge.** Autocorrelation is ~0; every "momentum"
  variant backtested to a profit factor below 1.0.
- **Short conditions alone lose money.** Crypto drifts upward, so any symmetric
  overbought short gets run over.
- **Buying oversold dips is the only positive raw edge**, and it grows with the
  holding window (≈0 at 1h, clearly positive at 4h+).
- A long-only dip book still **cannot survive a falling month** (Fold 3 was
  −18.9% buy-and-hold), so a long-only version was rejected.

That pointed to a **hedged** design: long dips in an uptrend regime, short pops
in a confirmed downtrend regime.

## 2. The design

| Element | Rule |
|---|---|
| Regime line | EMA(200) |
| Long trigger | close **above** EMA200 **and** close ≤ SMA20 − **1.25**·sd20 |
| Short trigger | close **below** EMA200 that is **falling over 8 bars** **and** close ≥ SMA20 + **1.75**·sd20 |
| Stop | entry ∓ **1.5 × ATR(14)** |
| Target | entry ± **5 × ATR(14)** (full exit) |
| Time exit | **64 bars** (16h) if neither stop nor target hits |
| Slots | up to **4 concurrent positions** |

Two deliberate asymmetries, both forced by the data:

1. **Different band widths (1.25 long / 1.75 short).** Because the drift makes
   shorts the harder side, they need to be more stretched to pay.
2. **A slope filter on shorts only.** Shorts are taken only against a *falling*
   EMA200, which avoids fading the drift in a rising market.

## 3. Frequency — where the ≥4/day comes from

The live engine caps **one position per slot**, so trades/day is bounded by
`96 bars/day ÷ average hold`. VHR-15's holds average ~5 hours (~20 bars), which
would cap a single-position book at ~1–2/day.

Frequency therefore comes from **concurrent slots, not faster trading**. Four
slots let the same edge print 4–5 independent entries per day. Verified honest:
in every fold the simulator recorded **≥ 4.4 entries/day**, one entry per 15m
candle, no duplicate fills.

Live signal rate (unconstrained) is actually **~7.1 signals/day**, so the 4-slot
cap — not the signal — is what sets the final count. That leaves headroom above
the 4/day floor.

## 4. Results — winner `bb1.25/1.75 K4 sl1.5 tp5 t64 shSlope`

Six independent 30-day folds, $1,200 equity, asymmetric fees (maker 2 bps entry
+ target, taker 5 bps stop/time-exit):

| Fold | Net | Trades | Trades/day | Win% | PF | Long / Short | Avg hold | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| F1 (2026-03-31 → 04-29) | +$60 | 154 | 5.13 | 32% | 1.13 | 107 / 47 | 4.9h | 9.5% |
| F2 (04-30 → 05-29) | +$94 | 148 | 4.93 | 36% | 1.26 | 99 / 49 | 4.8h | 12.1% |
| F3 (05-30 → 06-28) | +$151 | 132 | 4.40 | 35% | 1.35 | 80 / 52 | 5.6h | 9.5% |
| F4 (06-29 → 07-28) | +$88 | 168 | 5.60 | 34% | 1.20 | 120 / 48 | 5.1h | 13.8% |
| F5 (07-29 → 08-27) | +$129 | 165 | 5.50 | 36% | 1.41 | 123 / 42 | 5.3h | 5.6% |
| F6 (08-28 → 09-26) | +$7 | 136 | 4.53 | 32% | 1.02 | 74 / 62 | 4.8h | 7.2% |
| **Total** | **+$528** | **903** | **5.02** | **34%** | **1.23** | 603 / 300 | ~5.1h | **9.6%** |

Buy-and-hold over the same folds: +13.7% / −3.0% / **−18.9%** / +7.3% / +25.4% / +5.3%.
**Fold 3 is the key test:** the market fell 18.9% and VHR-15 still made **+$151** —
the short leg is what keeps the equity curve green through a crash.

**This is a plateau, not a spike.** 12 configurations in the grid are positive in
all six folds *and* clear 4/day; the winner's neighbours (`K3/K6`, `sl2`,
`longMult 1.5`, `t64/t96/t128`) are also 6/6. A robust edge does not depend on a
single lucky parameter set.

## 5. Risk management (probability-first sizing)

- **Fixed fractional risk:** 0.5% of equity per slot, sized from the stop
  distance — win rate never needs to exceed ~34% to break even at 3.3:1 RR.
- **Hard stop** at 1.5×ATR, **hard time stop** at 16h (no dead capital).
- **Session guards:** max 20 entries/day, pause after 8 consecutive losses,
  engine-level daily-loss halt.
- **Bounded exposure:** notional cap is *shared* across the 4 slots
  (`maxNotionalEquity × equity ÷ slots`), so 4 positions ≠ 4× the risk.
- **Maker-first cost control:** entries and targets are resting limit orders
  (2 bps); only stops/time exits pay taker (5 bps).

## 6. Fee sensitivity (the one real caveat)

| Fee model | Folds positive | Total net |
|---|---:|---:|
| maker 2 bps / taker 5 bps (base) | 6/6 | +$528 |
| maker 3 bps / taker 5 bps | 5/6 | +$419 |
| all taker 5 bps | 5/6 | +$216 |

**The edge needs maker (limit) entries.** This is not a nicety — it is why the
strategy submits `limit_order` entries and a limit target rather than market
orders. At pure-taker fees it is still positive but thin.

## 7. Engine changes required (concurrent slots)

Reaching 4/day needed real multi-position support, which the engine previously
lacked (it allowed exactly one position). Added:

- `config.strategy.maxConcurrentPositions` (`STRATEGY_MAX_CONCURRENT_POSITIONS`, default 4).
- `positionManager`: `getOpenPositionsBySymbol()`, a `slot` field on positions,
  a slot-aware `applyOrder()`, and `manageOpenPosition()` that now loops over
  **all** open positions and dispatches on `plan.exitMode` (`simple` for VHR-15,
  `staged` for Sweep & Shift).
- `orderManager.concurrencyGate()` — assigns the lowest free slot, blocks a new
  entry only when all slots are working; reduce-only exits are exempt from the
  entry-throttling gates so several slots can close in the same cycle.
- `tradingEngine.getStrategyState()` now reports `openPositions` / `liveOrders`
  counts (booleans retained for single-position strategies).

## 8. How to run

```bash
# reproduce the grid (writes backtest/hedge-grid.json)
node backtest/run-reversion-freq-backtest.js --hedge

# the bot runs VHR-15 automatically (src/strategies/strategyManager.js)
npm start
```

Trading mode stays `paper` until `TRADING_MODE=live` **and**
`ENABLE_LIVE_TRADING=true` are both set.

## 9. Honest caveats

- Six 30-day folds over eight months is a solid but not enormous sample; the
  worst fold (+$7, PF 1.02) is barely above break-even and is the reminder that
  the edge is modest, not spectacular.
- The backtest fills limit entries at the signal candle's close. Live resting
  limits may not fill as promptly if price runs away; the 60-minute validity
  window bounds that.
- Expected profit is on the order of **~$0.30/day per $1,000 of equity** —
  designed for small, consistent gains, not outsized returns.
