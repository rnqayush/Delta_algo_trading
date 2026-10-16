# Sweep & Shift (S&S-15) — BTC 15m Price-Action Strategy

**Instrument:** BTCUSD perpetual on Delta Exchange
**Execution timeframe:** 15-minute candles (all setups)
**Context timeframe:** 1-hour candles (direction filter only)
**Style:** 100% price action / market structure. No oscillators, no moving averages, no indicator crossovers.
**Status:** design specification + pseudocode. **Not validated. Not proven profitable.** Must pass backtesting → walk-forward → paper trading before any real money (see §16–17).

---

## 0. Design constants (the whole strategy uses only these)

Everything below is expressed with these five numbers plus price and candles. No other parameters exist.

| Name | Value | Meaning |
|---|---|---|
| `SWING_LOOKBACK` | 2 | A swing high at candle `i` needs `high[i] > high[i-1], high[i-2]` and `high[i] > high[i+1], high[i+2]`. A swing is only **confirmed** after candle `i+2` closes (no look-ahead). Swings lows mirrored. |
| `AVG_BODY_N` | 20 | `avgBody` = mean of `|close - open|` over the last 20 **closed** 15m candles. This is the volatility unit. |
| `DISPLACEMENT_X` | 1.2 | A candle counts as displacement when its body ≥ `1.2 × avgBody`. |
| `BUFFER_X` | 0.2 | Stop buffer = `max(tickSize, 0.2 × avgBody)`. |
| `MIN_RR` | 2.0 | Minimum reward-to-risk to the nearest opposing liquidity level. |

Two derived values are also fixed: `BOS_WINDOW = 6` candles and `ENTRY_VALIDITY = 4` candles.

`tickSize` and `contract_value` are **read from Delta's instruments API** for the configured symbol — never hardcoded (the project already has this: [marketService.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/delta/marketService.js#L37-L48)).

---

## 1. Strategy philosophy

The strategy assumes one thing about BTC: **the obvious levels get taken out before the real move, and the real move only starts after the market has proven that the previous direction failed.**

So it never buys a breakout. It waits for:

> **Liquidity sweep → reclaim → break of structure (BOS) → entry on the retest of the broken level**

That single pattern is used in both directions and only in the direction of the 1H trend. Everything else — selective entry, asymmetric R:R, small losses, no overtrading — falls out of that one pattern plus the risk rules.

Why this pattern and not "BOS → retest" alone: a plain BOS-retest fails constantly in choppy BTC conditions because a break of a minor swing high means nothing. Requiring a **sweep of real liquidity first** filters the break: the break only counts if it happens *after* the market has already raided stops. It is also trivially programmable: all conditions are candle-close comparisons.

**What the strategy deliberately does NOT do:**
- No entering on the sweep itself (that is knife-catching, and loses on continuation of the trend).
- No counter-trend trading by default (see §2).
- No indicator confirmation stack, no candle-pattern zoo, no Fibonacci targets, no multi-condition "confluence" of 30 rules.

---

## 2. Higher-timeframe filter (1H)

Compute 1H swings with the same `SWING_LOOKBACK = 2` fractal.

Notation: `SH1` = latest confirmed 1H swing high, `SH0` = the one before it. `SL1`/`SL0` same for lows.

| 1H environment | Condition | Consequence |
|---|---|---|
| **Bullish** | `SH1 > SH0` **and** `SL1 > SL0` (higher highs + higher lows) | Longs allowed (score 2 pts), shorts need the counter-trend tier |
| **Bearish** | `SH1 < SH0` **and** `SL1 < SL0` (lower highs + lower lows) | Shorts allowed (score 2 pts), longs need the counter-trend tier |
| **Neutral / range** | anything else | Both directions allowed, but score only 1 pt |

**Hard direction rules:**
1. A long is **only** executed when the 1H environment is Bullish, or Neutral, or when the **Trade Quality Score ≥ 8.5** (the strict counter-trend tier, §13). Bearish 1H caps a long at 8.0 pts, so a long against a bearish 1H is impossible without near-perfect execution quality — which is intentional.
2. The mirror rule applies to shorts against a bullish 1H.
3. Neutral 1H additionally requires price to sit in the right third of the 1H range: longs only if price is in the **lower third** of the last 20 1H candles' range; shorts only in the upper third. No trading in the middle third of a neutral 1H range.

This gives: trending 1H → trade with the trend; flat 1H → only trade the edges. Fewer, better trades.

---

## 3. Definitions used by both setups

### 3.1 Confirmed swing

A swing high is confirmed at candle `i+2` if `high[i]` is the highest of `high[i-2..i+2]`. Confirmed means "usable from the close of candle `i+2` onward". Slice structures so the strategy only ever sees confirmed swings — this is the single most common source of fake backtest profits.

### 3.2 Liquidity level

Two kinds, both objective:

1. **Swing liquidity** — the most recent confirmed 15m swing low (for downsides) or swing high (for upsides).
2. **Cluster liquidity (stronger)** — at least **2** confirmed swings of the same type whose extreme prices are within `0.15%` of each other. The level is the **most extreme** of them (the lowest low for a downside pool, the highest high for an upside pool).

Score rewards clusters (§13). A range boundary that has been touched 3+ times is also cluster liquidity.

### 3.3 The sweep (liquidity grab)

For a **long** (downside liquidity is taken):

- Let `L` = the downside liquidity level.
- Look at the last **3 closed candles**. A sweep has occurred if at least one candle in that window printed `low < L` (strictly, by at least 1 tick) **and** the same candle closed back **above** `L`.
- A sweep may also be completed by two candles: candle A prints `low < L`, and the **next** candle B closes above `L`, **provided** candle A's close is also ≥ `L - 0.25 × avgBody` (i.e. A did not decisively break down).
- `SE` (sweep extreme) = the lowest low of the sweep sequence.
- The sweep is **invalid** if any later candle closes below `SE` — that is real breakdown, not a sweep.

### 3.4 Break of structure (BOS)

For a long:

- `BOS_LEVEL` = the most recent **confirmed 15m swing high** that formed before or at the sweep candle.
- BOS = a 15m candle **closes above `BOS_LEVEL`** by at least 1 tick, with a **body ≥ 1.2 × avgBody** (displacement), and that close happens **within 6 candles of `SE`**.
- If no such close happens within 6 candles, the whole setup **expires** (it becomes just chop — see §8).

### 3.5 Opposing liquidity (target source)

For a long: all confirmed 15m swing highs and 1H swing highs **above** the entry candidate, from the last 40 15m candles and the last 20 1H candles, including range highs. `NEAREST_OPP` = the lowest of them. `NEXT_OPP` = the next one above that.

Reward used for the R:R test is always measured to `NEAREST_OPP` — never to an imaginary target.

---

## 4. Exact LONG setup

All conditions must be true. Evaluated only on closed candles.

**A. Market condition**
1. 1H is Bullish, or Neutral with price in the lower third of the 1H 20-candle range.
2. No active no-trade flag (§8): not compressed, not choppy, spread normal, volatility normal, daily limits not hit.
3. No position currently open for the symbol.

**B. Liquidity event**
4. A downside liquidity level `L` exists: the most recent confirmed 15m swing low, or a downside cluster (§3.2). `L` must be *below* the current price when the sweep starts.
5. A valid sweep of `L` occurred within the last 3 closed candles (§3.3). `SE` = sweep extreme.

**C. Confirmation**
6. A BOS candle closes above `BOS_LEVEL` (the last confirmed 15m swing high at or before the sweep) within 6 candles of `SE`, with body ≥ `1.2 × avgBody`.
7. The reclaim candle (the sweep candle itself if it reclaimed in one candle) is bullish (`close > open`) or has a lower wick ≥ 50% of its total range (rejection signature).

**D. Entry**
8. Place a **limit buy at `BOS_LEVEL × (1 + 0.0002)`** (BOS level + 2 bps), valid for **4 candles**.
9. If not filled in 4 candles → cancel, no entry, no chasing. Setup is dead.
10. Entry is a **retest entry**, never a market entry on the breakout candle. This is what buys the strategy its R:R: the stop is far below, so paying up 2 bps above the level is cheap.
11. Position size is computed from the actual fill price, not the limit price (see §11).

**E. Stop loss**
12. `SL = SE - BUFFER` where `BUFFER = max(tickSize, 0.2 × avgBody)`.
13. Reason: `SE` is the exact point where the sweep thesis is wrong — if price accepts below the sweep low, the "failed breakdown" is really a breakdown. The buffer only covers spread/wick noise, and it is tied to current volatility (`avgBody`), not to a made-up percentage.
14. `R = entryPrice - SL` (in quote currency). Hard cap: `R ≤ 1.2% of entryPrice`. If the structure demands a wider stop, **the trade is skipped** — never widen the stop, just refuse the trade.
15. The SL is a real resting **stop-market order** on Delta, placed immediately after the entry fill.
16. **Invalidation:** the setup dies if (a) the limit expires unfilled, (b) after entry, a 15m candle closes below `SL` (stop handles this), or (c) two consecutive 15m candles close back **below `BOS_LEVEL`** after entry → exit at market immediately (structure failure exit, §7).

**F. Take profit**
17. `TP1 = entry + 1R` → close **40%**.
18. `TP2 = entry + 2R` → close **30%**.
19. Runner = final **30%**, trailed structurally (§7). Final target is the pre-identified `NEAREST_OPP` / `NEXT_OPP`, whichever is reached first while the trail holds.
20. **Precondition to take the trade at all:** `NEAREST_OPP - entry ≥ 2.0 × R`. Preferred ≥ 2.5R. If less → no trade (§6).

---

## 5. Exact SHORT setup

Exact mirror. All conditions must be true.

**A. Market condition**
1. 1H is Bearish, or Neutral with price in the upper third of the 1H 20-candle range.
2. No no-trade flag active (§8).
3. No open position on the symbol.

**B. Liquidity event**
4. An upside liquidity level `H` exists: most recent confirmed 15m swing high, or an upside cluster. `H` must be *above* current price when the sweep starts.
5. Valid sweep: within the last 3 closed candles, a candle printed `high > H` (≥ 1 tick) and closed back **below** `H` (or candle A prints `high > H` and candle B closes below `H` with A's close ≤ `H + 0.25 × avgBody`). `SE` = highest high of the sweep.

**C. Confirmation**
6. A BOS candle closes **below `BOS_LEVEL`** (last confirmed 15m swing low at or before the sweep) within 6 candles of `SE`, body ≥ `1.2 × avgBody`.
7. The rejection candle is bearish or has an upper wick ≥ 50% of its range.

**D. Entry**
8. Limit **sell at `BOS_LEVEL × (1 - 0.0002)`**, valid 4 candles.
9. Not filled in 4 candles → cancel.
10. No market entry on the breakdown candle.

**E. Stop loss**
11. `SL = SE + BUFFER`, same `BUFFER` definition.
12. `R = SL - entryPrice`. Hard cap `R ≤ 1.2% of entryPrice`, else skip.
13. Real resting stop-market order on Delta immediately after the fill.
14. **Invalidation:** limit expiry, a close above `SL`, or two consecutive 15m closes back **above `BOS_LEVEL`** → exit at market.

**F. Take profit**
15. `TP1 = entry - 1R` → close 40%.
16. `TP2 = entry - 2R` → close 30%.
17. Runner 30%, structurally trailed; target = `NEAREST_OPP` (nearest confirmed swing low / 1H swing low below entry).
18. Precondition: `entry - NEAREST_OPP ≥ 2.0 × R`, preferred ≥ 2.5R.

---

## 6. Risk/Reward rules

Computed **before** the order is placed, in this order:

1. `R = |entry - SL|`.
2. `reward = |NEAREST_OPP - entry|`.
3. `rr = reward / R`.
4. **Reject if `rr < 2.0`.** No exceptions, no "close enough", no "I'll take half". Note this is a *hard* gate that will reject many visually perfect setups — that is the point.
5. `rr ≥ 2.5` earns a score bonus (§13).
6. Additionally require **room to run**: `|NEXT_OPP - entry| ≥ 2.5 × R`. If the very next opposing level sits just past 2R, the runner has no oxygen and the trade is rejected.

The R:R is measured against **structure**, not against a fixed target. If the nearest opposing liquidity is too close, the R:R is bad no matter how pretty the entry looked.

---

## 7. Trade management (objective, post-entry)

State machine: `PENDING → OPEN → PARTIAL_1 → PARTIAL_2 → RUNNER → CLOSED`.

| # | Rule | Trigger | Action |
|---|---|---|---|
| 1 | Initial SL | Immediately after fill | Stop-market at `SL` (§4E). Never widened. |
| 2 | TP1 | Price ≥ entry + 1R | Close 40% (limit order). |
| 3 | TP2 | Price ≥ entry + 2R | Close 30% (limit order). |
| 4 | **No breakeven before +2R** | — | SL stays where it is until TP2 is filled. Rationale below. |
| 5 | Lock-in | After TP2 fills | Move SL to `entry + 1R` (locks ≥ +1R on the remainder). |
| 6 | Structural trail | Only after rule 5 | `SL = max(SL, lastConfirmedSwingLow - BUFFER)` for longs (mirror for shorts). **Ratchet only** — never looser. |
| 7 | Structure-failure exit | 2 consecutive 15m closes back beyond `BOS_LEVEL` | Exit remaining size at market. Most losers end here, at −0.2R…−0.6R instead of −1R. |
| 8 | Runner final exit | (a) trail hit, (b) price tags the pre-identified opposing level **and** a candle closes back against the position, or (c) 12 candles with no new extreme beyond +2R | Exit at market. |
| 9 | Stall exit | After 8 candles the trade is still inside `[-0.5R, +0.5R]` | Exit at market. Frees capital, avoids converting a non-mover into a loser. |
| 10 | Fast move | Price reaches +2R within ≤3 candles | Do nothing special: keep TP1/TP2 as planned, keep the runner, disable the rule-8c time stop for that trade. |
| 11 | Gap / spasm | A single candle range > 3 × avgBody in the wrong direction, or the SL is jumped by more than 0.3% of price | Stop is a stop; accept the slippage, exit, then the safety engine halts new entries for 4 candles (§9/§20). |

**Why rule 4 (no early breakeven).** BTC routinely retraces 50–70% of an impulse before continuing. Moving to breakeven after +1R systematically kills the trades that would have become 3R–5R winners, and it *feels* good while lowering expectancy. Keeping full risk on the remaining 70% is made acceptable by rule 2: after TP1, the worst realistic outcome is `0.4 × 1R - 0.6 × 1R = -0.2R`. Small partial, full stop, is a better trade-off than full partial, breakeven stop.

**Note on partials.** Partial exits mathematically reduce the average winner (the 40% taken at 1R would have often run to 4R). This is a deliberate trade-off: it cuts variance, cuts drawdown, and makes the equity curve survivable during paper trading and the first live phase. It must be measured in the backtest — if `expectancy(no partials)` is meaningfully higher *and* max drawdown stays acceptable, dropping TP1 is a legitimate variant (§16 metric comparison). Do not change it on a hunch.

---

## 8. No-trade conditions

Any one of these blocks all new entries. This list is the second half of the strategy.

**Structural**
1. **Compression:** `(highest high − lowest low)` of the last 20 closed 15m candles `< 0.5% of price` → no trade (no room for an asymmetric move). Exception: only trade a compression range if a **cluster** boundary gets swept *and* BOS follows — that is the expansion trade, and it scores high.
2. **Chop:** ≥ 3 false breakouts in the last 20 candles. Definition of a false breakout: a candle whose high exceeds the previous 10-candle high but closes below it (or the mirror for lows) → mandatory stand-down for the next **8 candles**.
3. **Range at the wrong edge:** neutral 1H and price in the middle third of the 1H range.
4. **Unclear structure:** fewer than 2 confirmed 15m swing highs **or** swing lows in the last 20 candles → the fractal is undefined, skip.
5. **Extended move:** the entry would sit more than `3 × avgBody` from the last 15m swing extreme of the current leg, or there are ≥ 4 consecutive same-direction candles without a pullback. Entering after an extended move means buying the top of the impulse — small loss, no reward.
6. **Wall ahead:** `rr < 2.0` to `NEAREST_OPP`, or the next opposing level is closer than `2.5R`.
7. **Entry too far from invalidation:** `R > 1.2% of price`.
8. **Failed confirmation:** no BOS within 6 candles of `SE`.

**Market quality**
9. **Spread:** `(bestAsk − bestBid) / mid > 0.05%` → no new entries until it normalises for 2 candles.
10. **Abnormal volatility:** the last closed candle's range `> 3 × avgBody`, or the last 5 candles' average range `> 2.5 × ` the previous 20 candles' average → wait 4 candles (news/expiry spasm).
11. **Stale data:** no new 15m candle for more than 1 candle period, or no ticker update for > 60s → halt entries; if a position is open, manage it conservatively (§20).
12. **Session gap:** a candle that opens more than 1.5% away from the previous close → cancel pending limits, skip that setup.

**Risk state**
13. Daily loss limit hit, consecutive-loss limit hit, trade count limit hit, or kill switch engaged (§12).

### How to identify a range using price action (no indicators)

A range exists when **the last 3 confirmed 15m swing highs are within 0.35% of each other AND the last 3 confirmed swing lows are within 0.35% of each other**, and their average range width is `< 2.5% of price`. In that state, only the boundaries are tradeable, and only via sweep + BOS. When 1H shows the same flat-swing pattern, treat the whole market as range-bound and require the boundary sweep.

---

## 9. Fake-breakout protection

The rule is structural, not statistical:

> **Never enter on the break. Only enter on the retest of the level that broke.**

Concretely:
1. The BOS candle is only a *permission slip*. The order goes in at the level, not at the close.
2. If price never returns (runs away), there is no trade. Missing a trade costs nothing; entering a fake break costs 1R.
3. A break without a prior sweep is not a break at all — no sweep, no BOS, no trade.
4. If a break happens and then price closes back through the level within 4 candles, that is a *failed* break; the setup is deleted and the level is marked "dirty" for 8 candles (it cannot be used as a `BOS_LEVEL` again in that window).

Thus the pattern is `sweep → break → accept/retest → entry`, never `break → entry`.

---

## 10. Stop-hunt protection

The stop goes below the **sweep extreme**, not below the obvious swing low, and not below a round number.

1. By definition, the sweep already consumed the stops sitting at the visible swing low. `SE` is a *less obvious* level than the swing low itself.
2. Buffer = `max(tickSize, 0.2 × avgBody)` — volatility-scaled, wide enough to survive wick noise, far too narrow to be a "hope stop".
3. Round-number avoidance: if `|SL − nearestRoundHundred| < tickSize × 2` for BTC, shift the SL away from the round number by `0.05 × avgBody`. Costs almost nothing in R, removes a magnet.
4. Hard cap `R ≤ 1.2%` of price means we never solve the hunt problem by simply making the stop huge. If the structure forces a wide stop, the trade is skipped.
5. The priority ordering is explicit: **small controlled loss with valid structural invalidation** beats "a stop that never gets hit".

---

## 11. Position sizing

### Formula

```
riskAmount   = equity × riskPercent
sizeInBase   = riskAmount / |entry - SL|          // BTC amount
contracts    = sizeInBase / contract_value        // contract_value from Delta instruments API
notional     = sizeInBase × entryPrice
marginUsed   = notional / leverage                // this is all leverage changes
```

`riskAmount` is the **maximum** loss if the stop is hit cleanly. Slippage is bounded separately: assume the SL fills 0.1% beyond the level, so real worst-case loss ≈ `1.03R`–`1.05R`. Size with that in mind.

### Worked example (₹ account, USD-denominated contract)

Account: **₹100,000 ≈ $1,200** (assume ₹83.3 per USD — re-check the rate live).
Risk per trade: **0.5%** → risk = $6.00.
Assume `entry = 100,720`, `SL = 99,925` → `R = 795` per BTC.

```
sizeInBase = 6.00 / 795          = 0.00755 BTC
notional   = 0.00755 × 100,720   ≈ $760
```
With `contract_value = 1 USD` per contract (verify in the instruments API), that is ≈ 760 contracts.

Leverage: at **10×**, margin = `$760 / 10 = $76`. At **50×**, margin = `$15.20`.

> **Leverage changes margin requirement, not the planned account risk.**
> In both cases the planned loss if the stop is hit is **$6.00 (0.5%)**. Leverage only decides how much collateral is locked up. Using leverage to increase `riskPercent` is a different, much worse decision, and this strategy forbids it.

### Hard caps

- Max notional per trade ≤ **3 × equity** (regardless of the formula's output) — in the example, the $760 notional is fine.
- Max total notional ≤ **5 × equity**.
- Max open positions: **1** for this strategy.
- If computed `sizeInBase × entryPrice` > max notional, reduce size (do **not** widen the stop, do **not** shrink the risk below the practical minimum — if the resulting risk is under ~0.1% of equity, skip the trade as too small to matter).

---

## 12. Risk management & daily protection

| Rule | Value | Rationale |
|---|---|---|
| Risk per trade | **0.5%** of equity | Recommended default for an unproven system. 1% doubles both returns and drawdown; with a 2R average winner and a real losing streak probability distribution, 0.5% keeps the risk of ruin negligible while results are gathered. Move to 0.75–1% only after §17 is satisfied. |
| Max risk per trade | 1.0% (hard) | Even with a "perfect" score, never more. |
| Max daily loss | **−2% of equity** or **−3R**, whichever hits first → stop for the day | Three full stop-outs in a day means the day's conditions are hostile. |
| Max consecutive losses | **2** → stop for the day | A 2-loss streak on a 40%-win-rate strategy is entirely normal, not a signal to size up. Stopping after the streak is cheap insurance against tilt and against regime change. |
| Max trades per day | **4** | 15m BTC usually offers 0–3 A-grade setups. A 4th trade already means we were bored. |
| After 2 or 3 consecutive losses | Stop the day; next day starts at base size | No size change after a loss, ever. |
| Stop trading for the day when | Daily loss limit, 2 consecutive losses, 4 trades taken, or any safety-halt event | Hard-coded, not discretionary. |
| Re-entry rule | A stopped-out setup cannot be re-entered on the same level the same day | Prevents revenge trading; the level is "dirty" for the session. |

**Forbidden, unconditionally:** martingale, averaging down, moving the SL further away, re-entering after a loss to "get it back", increasing size after a win streak, trading beyond the daily stop, trading without a resting SL.

**Daily state to persist** (so a bot restart does not reset the day's budget): `tradesToday`, `consecutiveLosses`, `realizedPnlToday`, `rMultipleToday`, `lastLossAt`, `dirtyLevels`.

---

## 13. Trade Quality Score (0–10)

Additive, computed before entry. Threshold: **score ≥ 7.0 to execute**; **≥ 8.5 required for a counter-trend trade**.

| Factor | Points | Scoring |
|---|---|---|
| 1H alignment | 0 / 1 / 2 | with-trend = 2, neutral = 1, against = 0 |
| Sweep quality | 0 / 1 / 2 | cluster (≥2 touches) = 2, single swing = 1, ambiguous = 0 |
| Rejection / displacement strength | 0 / 0.75 / 1.5 | reclaim candle body ≥ 1.5 × avgBody **and** closes in the top/bottom third of its range = 1.5; body ≥ 1.2 × avgBody = 0.75; else 0 |
| BOS quality | 0 / 0.75 / 1.5 | closes ≥ 0.1% beyond `BOS_LEVEL` with body ≥ 1.5 × avgBody = 1.5; plain valid BOS = 0.75 |
| Entry quality | 0 / 1 | limit filled on the retest within 4 candles = 1; otherwise no trade |
| R:R to `NEAREST_OPP` | 0.5 / 0.75 / 1 | ≥ 3R = 1; 2.5–3R = 0.75; 2.0–2.5R = 0.5; < 2R disqualifies the trade |
| Room to next opposing level | 0 / 0.5 | `NEXT_OPP ≥ 2.5R` = 0.5 |
| Market conditions | 0 / 0.25 / 0.5 | no no-trade flags = 0.5; one soft flag (e.g. spread slightly wide) = 0.25; any hard flag = trade blocked regardless of score |

**Total = 10.0.**

Log the score with every trade. In the backtest, compare the equity curve of `score ≥ 7` vs `score ≥ 8` vs `no filter` — if the filter earns its keep, keep it; if not, it is overfitting and should be simplified to just the hard rules. The score is a **ranking and sizing input**, not magic.

---

## 14. BTC-specific considerations

| BTC behaviour | Why | How the strategy handles it |
|---|---|---|
| Sweeps highs/lows before reversing | Stop clusters sit at obvious swing points; market makers push through them to fill size | The entire entry pattern is built on the sweep — the strategy trades *with* this behaviour instead of being its victim |
| Volatility expansion after consolidation | Compression stores energy; the first accepted break after a compression range travels far | Compression blocks normal entries (§8.1) but the compression-boundary sweep + BOS is a maximum-score setup |
| Frequent false breakouts | BTC loves to print a wick through a level and reverse | No entry on the break; entry only on the retest (§9) |
| Strong impulsive moves | Impulses cover 3–6 × avgBody in a few candles, then retrace | BOS requires displacement; the runner is trailed on structure, not on a fixed target |
| Deep retracements after large candles | 50–70% retracement is normal | No breakeven stop before +2R (§7.4); entries are on retests, so the retracement is the entry mechanism |
| Liquidity at obvious swing points | Old highs/lows are self-reinforcing magnets | `NEAREST_OPP` / `NEXT_OPP` for targets, and the same levels as `BOS_LEVEL` and sweep candidates |
| Weekend vs weekday | Weekend BTC liquidity is thinner, wicks are longer, follow-through is weaker | **Untested idea, must be measured:** treat weekend sessions with `avgBody` computed from the last 40 candles instead of 20 (the volatility unit adapts), and require the higher score band (≥ 8.0) on Saturdays/Sundays. Do not hard-code a weekend ban until the backtest shows it is warranted |
| Funding on perpetuals | 8-hourly funding is a real cost for positions held for hours | Include funding in the backtest (§16). Setups hold for candles-to-hours, so funding is small but not zero, and it matters for the runner that stays open longest |

Do not add rules here that cannot be measured. Every line in this table is either already a rule above or is explicitly labelled "measure first".

---

## 15. Avoid overfitting — what the strategy deliberately refuses

- **No indicator stack.** Zero oscillators, zero moving averages, zero divergence logic.
- **5 numeric parameters total** (§0) + `SWING_LOOKBACK`. That is the entire parameter surface: 6 numbers. Any version with 20+ tunables is rejected by design.
- `SWING_LOOKBACK = 2` is not tuned per period; it is a structural choice (a 5-candle fractal is the smallest meaningful swing on a 15m chart). If it must be tested, test 2 vs 3 only.
- **No curve-fitted levels.** Levels are recomputed from the most recent confirmed swings on every evaluation; no stored historical prices.
- **No per-regime rule variants.** One rule set, applied throughout history. If it only works in 2024, it does not work.
- **Beware the two silent overfit traps specific to this strategy:**
  1. **Look-ahead bias in swing confirmation** — a swing is only valid 2 candles after it prints. A backtest that uses swings immediately will show inflated results.
  2. **Limit-entry fill assumption** — assuming the retest limit always fills is the classic way to fake a 2.5R system. Real fills need the price to trade *through* the limit, and some fills happen right before the trade fails.

---

## 16. Backtesting requirements

### Data required

| Input | Detail |
|---|---|
| 15m OHLCV | BTCUSD perpetual, ≥ 2 years, must include a bull phase, a bear phase and a chop phase. Source: Delta `/v2/history/candles` (already wired in [marketService.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/delta/marketService.js#L123-L135)) or an independent archive for cross-checking |
| 1H OHLCV | Same span, same source, same gaps |
| Fees | Delta taker fee for market orders (SL and stall exits) and maker fee for the limit entry and TP limits — read the current schedule from Delta, do not assume |
| Funding | 8-hourly funding history for the perpetual; charge/credit on open position notional |
| Slippage | Market exits: 0.1% adverse on SL hits, 0.05% adverse on other market exits. Limit entries: filled only if `low ≤ limit` (long) / `high ≥ limit` (short) within the 4-candle validity |
| Execution model | Signals evaluated on bar close only. Entry at the limit price on the bar that touches it, plus one bar of delay tolerance. SL is intrabar; if a bar's range contains both SL and TP1, assume **SL first** (pessimistic) |
| Clock | Use exchange time, handle gaps and missing candles explicitly (do not silently interpolate) |

### Metrics to report (all of them, every run)

Win rate · average R per trade · profit factor · expectancy (in R) · max drawdown (% and in R) · average winner (R) · average loser (R) · largest loser (R) · max consecutive losses · number of trades · risk of ruin at 0.5% risk · return/drawdown ratio · long vs short breakdown · distribution of exit reasons (TP1 / TP2 / trail / structure failure / SL / stall).

### What "healthy" looks like (targets, not promises)

| Metric | Acceptable | Good |
|---|---|---|
| Profit factor (after fees/funding) | ≥ 1.25 | ≥ 1.5 |
| Expectancy | ≥ +0.15R per trade | ≥ +0.25R |
| Average R per trade | ≥ +0.2R | ≥ +0.35R |
| Win rate | 35–50% | anything ≥ 35% |
| Average winner ÷ average loser | ≥ 1.8 | ≥ 2.5 |
| Max drawdown at 0.5% risk | ≤ 12% of equity | ≤ 8% |
| Max consecutive losses | ≤ 10 | ≤ 8 |
| Number of trades | ≥ 150 (statistical floor) | ≥ 300 |
| Return / max drawdown | ≥ 1.5 | ≥ 2.5 |

**Do not optimise for win rate.** A 35% win rate at 3R average winner is far better than 75% at 0.3R. A high win rate with a negative expectancy is the most common way to lose money slowly.

If a run shows a win rate above 65% on this pattern, be suspicious: it almost always means the limit-entry fill assumption is unrealistic or the swing look-ahead bias is present.

---

## 17. Walk-forward validation

1. **Backtest** the full history with all costs (§16). Record it and freeze the rules.
2. **Split**: rolling windows of 6 months train / 2 months test, anchored forward, no shuffling. Parameters do not change between windows — the "train" phase only confirms the fixed rule set, it is not a tuning phase.
3. **Out-of-sample test** on a period never looked at during design (e.g. hold out the most recent 6 months from the start).
4. **Walk-forward aggregate**: the concatenated out-of-sample equity curve is the only curve that counts for the go/no-go decision. In-sample results are marketing.
5. **Costs always on**: fees, funding, slippage. A run without costs is not a result.
6. **Paper trade** live for **≥ 3 months or ≥ 50 trades** (whichever is longer) at zero-to-minimal risk. Compare live metrics to the backtest band: win rate, average R, exit-reason distribution. A large mismatch means the execution model is wrong, not that the market changed.
7. **Then go live small**: start at **0.1% risk per trade** for the first 50 live trades. Only if live expectancy sits inside the backtest confidence interval do you step to 0.25%, then 0.5%. Never jump straight to 1%.

### How to avoid overfitting-by-iteration

- **Freeze the rules before looking at the results.** Write the rule set (this document), timestamp it, and treat changes as new versions with a new forward test.
- Keep a **change log**: every rule change, why, and what it did to out-of-sample results. If more than ~3 changes are needed, the strategy is being curve-fitted, not improved.
- Reject any change that improves in-sample results by < 10% but reduces the number of trades substantially — that is noise-fitting.
- Anything that only works when one specific month is included is a red flag. Re-run without it.

---

## 18. Automation-friendly rule table

Every rule as **Input → Condition → Action → Invalidation**.

| # | Input | Condition (evaluable from closed candles) | Action | Invalidation |
|---|---|---|---|---|
| R1 | 1H swings | `SH1>SH0 && SL1>SL0` | bias = LONG | bias re-evaluated every 1H close |
| R2 | 1H swings | `SH1<SH0 && SL1<SL0` | bias = SHORT | same |
| R3 | 1H swings | neither (and price not in the correct third) | bias = NONE | new 1H swing confirmed |
| R4 | 15m swings | latest confirmed swing low `L` exists and price > L | candidate downside liquidity | L replaced by a newer confirmed swing low |
| R5 | last 3 closed 15m candles | any `low < L` and that candle closes `> L` | sweep detected, `SE` = min low | any close below `SE` |
| R6 | 15m swings | a confirmed swing high `BOS_LEVEL` exists at/before the sweep | pending BOS | setup expires after 6 candles |
| R7 | closed 15m candle | `close > BOS_LEVEL` and `body ≥ 1.2×avgBody` | BOS confirmed | — |
| R8 | — | `rr = (NEAREST_OPP − entry)/R ≥ 2.0` and `NEXT_OPP ≥ 2.5R` | place limit at `BOS_LEVEL×1.0002` | limit unfilled for 4 candles |
| R9 | fill | entry filled | place stop-market at `SE − BUFFER`; compute size from fill | candle close below SL |
| R10 | price | `≥ entry + 1R` | close 40% | — |
| R11 | price | `≥ entry + 2R` | close 30% | — |
| R12 | price + swings | after TP2 | `SL = max(SL, lastSwingLow − BUFFER)` | never loosens |
| R13 | 15m closes | 2 consecutive closes below `BOS_LEVEL` | exit all at market | — |
| R14 | candle count | 8 candles in `[−0.5R, +0.5R]` | exit at market | — |
| R15 | refusals | any §8 flag | signal = `HOLD` with a machine-readable reason | flag clears |

Every signal logged by the bot should carry: `side, entry, sl, tp1, tp2, rr, score, reason, se, bosLevel, avgBody, timestamp`. That is what makes the paper-trading comparison in §17 possible.

---

## 19. Mapping to this codebase (engine separation)

The strategy logic must stay independent of Delta's API. Mapping onto the existing layered project:

| Layer | Responsibility | Where it lives / what's missing |
|---|---|---|
| **Strategy Engine** | Emits `BUY / SELL / HOLD` + trade plan | New `src/strategies/strategies/sweepShiftStrategy.js` implementing `getName()`, `evaluate(marketData, state)`, `reset()` — the same interface the example uses ([exampleStrategy.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/strategies/strategies/exampleStrategy.js#L7-L15)). **Gap:** `evaluate()` currently receives a *ticker*, and Delta's ticker payload has no OHLC. The strategy needs closed 15m/1H candles → use `marketService.getCandles()` on a 15m cadence, or aggregate ticks into candles and only evaluate on bar close. |
| **Risk Engine** | Position size, SL/TP sanity, daily loss, streak limits, score threshold | Extend [riskManager.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/trading/riskManager.js#L25-L97) — it currently validates order size, daily PnL, duplicates and price deviation, but it does **not** size positions from stop distance. That logic belongs here as a pure function (easy to unit test, matching the file's existing design intent). |
| **Execution Engine** | Order placement / modification / cancellation / fills | [orderManager.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/trading/orderManager.js) + `services/delta/orderService.js`. **Gap:** the signal contract is `{action, symbol, quantity, price, orderType}` ([helpers.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/utils/helpers.js#L103-L116)) — it must be extended with `stopLoss`, `takeProfit`, `reduceOnly`, `clientOrderId` propagation so the engine can place the bracket. |
| **Trade Manager** | SL / TP / trailing / partials / state machine | [positionManager.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/trading/positionManager.js) — it tracks positions, applies fills and computes PnL, but has no SL/TP/trailing/partial-exit state machine. That is the largest missing piece. |
| **Safety Engine** | Kill switch, daily loss, duplicate orders, API error backoff, stale data, gap protection | Partly in `riskManager.js`, partly scattered. Should become one owner with persisted daily state (§12) so a restart cannot reset the day's budget. |

**Rule that matters most here:** the engine must never treat an API failure as "flat". If an order's state is unknown, halt, reconcile with `positionService.getOpenPositions()`, and only then resume.

---

## 20. Emergency safety rules

| # | Threat | Protection |
|---|---|---|
| 1 | Oversized position | Max notional per trade ≤ 3 × equity; max total ≤ 5 × equity; enforce in the Risk Engine, not the strategy |
| 2 | Daily loss | Hard stop at −2% equity or −3R; persisted so restarts cannot bypass it |
| 3 | Too many positions | Max 1 position for this strategy, max 1 per symbol |
| 4 | Duplicate orders | Use `clientOrderId` from `generateClientOrderId()` plus the existing duplicate window in [riskManager.js](file:///d:/Projets/My%20Projects/Delta_Exchange/src/services/trading/riskManager.js#L76-L82) |
| 5 | API failure | 3 retries with exponential backoff (1s/3s/9s). 5 consecutive failures or a persistent auth error → **halt trading**, keep managing open positions |
| 6 | Stale price | No ticker update for > 60s, or no new 15m candle for > 20 minutes → no new entries; if a position is open and the stop cannot be verified, exit at market once connectivity returns |
| 7 | Unexpected gap | Candle opens > 1.5% from previous close → cancel pending limits, stand down 4 candles |
| 8 | Order rejection | Retry once with the same `clientOrderId`; on the second rejection, cancel the setup and log loudly. If the entry was rejected but the SL was placed, cancel the SL |
| 9 | Restart / recovery | On boot: reconcile positions from Delta, re-attach SL/TP for any position that lacks them, rebuild daily counters from the DB, and **never** re-place an order that may already exist — query first |
| 10 | Bot shutdown | 10 API errors in 60s, or 3 consecutive failed reconciliations → full shutdown, alert, and stop accepting signals |
| 11 | Manual kill switch | `RISK_TRADING_ENABLED=false` in env (already honoured by the Risk Engine), plus an admin endpoint and a file/flag check for a hard stop that does not require redeploy |
| 12 | Runaway strategy | Any signal whose `score`, `rr` or `R` is missing → reject at the Risk Engine boundary; the engine never trusts strategy-supplied numbers blindly |

---

## 21. Final deliverable

### A. Strategy name

**Sweep & Shift (S&S-15)** — BTC 15m liquidity-sweep continuation.

### B. One-paragraph explanation

Sweep & Shift trades only after the market has taken out an obvious pool of stops and then failed to hold the break. On the 15-minute chart we mark the last confirmed swing low (for longs). If price wicks below it and closes back above it, that is a sweep — the stops are gone. We then wait for a strong candle to close above the most recent swing high (a break of structure). Instead of buying the break, we leave a limit order at that broken level and wait for the pullback, which gives us a tight, structure-based stop just below the sweep low and a target at the next pool of liquidity above. We risk 0.5% of the account, take 40% off at 1R, 30% at 2R, and trail the last 30% on 15-minute swing lows. We trade only with the 1-hour trend, only when the reward to the nearest opposing liquidity is at least 2× the risk, and we stop for the day after two losses. Small losses, occasional large winners.

### C. Exact long rules (numbered)

1. 1H is Bullish (`SH1>SH0` and `SL1>SL0`), or Neutral with price in the lower third of the last 20 1H candles' range.
2. No §8 no-trade flag is active.
3. No open position on BTCUSD.
4. A downside liquidity level `L` exists (latest confirmed 15m swing low, or a ≥2-touch cluster within 0.15%).
5. Within the last 3 closed 15m candles: a candle printed `low < L` and closed `> L` (or candle A printed `low < L` with `closeA ≥ L − 0.25×avgBody` and candle B closed `> L`).
6. `SE` = lowest low of the sweep; no subsequent close below `SE`.
7. The reclaim candle is bullish, or has a lower wick ≥ 50% of its range.
8. Within 6 candles of `SE`, a 15m candle closes above `BOS_LEVEL` (last confirmed 15m swing high at/before the sweep) with body ≥ `1.2 × avgBody`.
9. Entry = limit buy at `BOS_LEVEL × 1.0002`, valid 4 candles; cancel if unfilled.
10. `SL = SE − max(tickSize, 0.2 × avgBody)`, shifted away from a round number if it lands within 2 ticks of one.
11. `R = entry − SL` must be ≤ 1.2% of entry, otherwise skip (never widen).
12. `NEAREST_OPP − entry ≥ 2R` and `NEXT_OPP − entry ≥ 2.5R`, otherwise skip.
13. Trade Quality Score ≥ 7.0 (≥ 8.5 if 1H is bearish).
14. Size = `(equity × 0.005) / R`, capped so notional ≤ 3 × equity.
15. Resting stop-market at `SL` placed immediately after the fill.

### D. Exact short rules (numbered)

1. 1H is Bearish (`SH1<SH0` and `SL1<SL0`), or Neutral with price in the upper third of the last 20 1H candles' range.
2. No §8 no-trade flag is active.
3. No open position on BTCUSD.
4. An upside liquidity level `H` exists (latest confirmed 15m swing high, or a ≥2-touch cluster within 0.15%).
5. Within the last 3 closed 15m candles: a candle printed `high > H` and closed `< H` (or candle A printed `high > H` with `closeA ≤ H + 0.25×avgBody` and candle B closed `< H`).
6. `SE` = highest high of the sweep; no subsequent close above `SE`.
7. The rejection candle is bearish, or has an upper wick ≥ 50% of its range.
8. Within 6 candles of `SE`, a 15m candle closes below `BOS_LEVEL` (last confirmed 15m swing low at/before the sweep) with body ≥ `1.2 × avgBody`.
9. Entry = limit sell at `BOS_LEVEL × 0.9998`, valid 4 candles; cancel if unfilled.
10. `SL = SE + max(tickSize, 0.2 × avgBody)`, round-number-adjusted.
11. `R = SL − entry` must be ≤ 1.2% of entry, otherwise skip.
12. `entry − NEAREST_OPP ≥ 2R` and `entry − NEXT_OPP ≥ 2.5R`, otherwise skip.
13. Trade Quality Score ≥ 7.0 (≥ 8.5 if 1H is bullish).
14. Size = `(equity × 0.005) / R`, notional cap 3 × equity.
15. Resting stop-market at `SL` placed immediately after the fill.

### E. Entry rules

- Type: **limit order on the retest** of the broken structure level, offset 2 bps in the breakout direction.
- Validity: **4 candles**. Expired = no trade.
- Fill price is the reference price for SL distance, R, TP levels and position size.
- Never a market entry on the BOS candle, never a chase, never a second attempt at the same level on the same day.

### F. Stop-loss rules

- Position: beyond the sweep extreme, `SE ∓ max(tickSize, 0.2 × avgBody)`.
- Placed as a live stop-market order immediately after the fill.
- Never widened. Ever.
- Setup is invalidated by: limit expiry, a candle close beyond the SL, or two consecutive 15m closes back beyond `BOS_LEVEL`.

### G. Take-profit rules

- TP1 = `entry ± 1R` → 40% out (limit order, resting).
- TP2 = `entry ± 2R` → 30% out (limit order, resting).
- Runner = 30% trailed on confirmed 15m swings, with the final objective at the pre-identified opposing liquidity pool.

### H. Trade management (after entry)

1. SL resting from the start; nothing else changes until +1R.
2. At +1R: 40% off.
3. At +2R: 30% off, then SL moves to +1R (locked).
4. After +2R: trail on `lastConfirmedSwingLow − BUFFER` (long), ratchet only.
5. Any time: two consecutive closes back beyond `BOS_LEVEL` → exit at market.
6. Any time after 8 candles in `[−0.5R, +0.5R]` → exit at market (stall).
7. Runner: exit on trail hit, on rejection at the opposing level, or after 12 candles without a new extreme beyond +2R.
8. Fast moves: no special handling except disabling the 12-candle time stop.

### I. Risk management (exact)

- Risk per trade: **0.5% of equity** (hard max 1%).
- Size: `sizeInBase = (equity × 0.005) / |entry − SL|`; `contracts = sizeInBase / contract_value`.
- Leverage: affects **margin only**. `margin = notional / leverage`. Planned risk stays 0.5%.
- Daily stop: **−2% equity or −3R**, whichever first.
- Consecutive losses: **2** → stop for the day.
- Max trades/day: **4**.
- Max open positions: **1**. Max notional per trade: **3 × equity**.
- Forbidden: martingale, averaging down, moving SL wider, re-entering a stopped-out level the same day, trading after the daily stop.

### J. No-trade checklist

☐ Compression: 20-candle range < 0.5% of price
☐ Chop: ≥ 3 false breakouts in the last 20 candles → wait 8 candles
☐ Neutral 1H and price in the middle third of the 1H range
☐ Fewer than 2 confirmed swing highs or lows in the last 20 candles
☐ Entry > 3 × avgBody from the last swing extreme, or ≥ 4 consecutive same-direction candles
☐ `rr < 2.0` to nearest opposing liquidity, or next opposing level < 2.5R
☐ `R > 1.2%` of price
☐ No BOS within 6 candles of the sweep
☐ Spread > 0.05% of mid
☐ Last candle range > 3 × avgBody, or 5-candle average range > 2.5 × the prior 20-candle average
☐ Stale data: no new candle in > 20 min, or no tick in > 60s
☐ Candle opened > 1.5% from the previous close
☐ Daily loss / streak / trade-count limit reached, or kill switch on
☐ Score < 7.0 (or < 8.5 for a counter-trend trade)

### K. 0–10 Trade Quality Score

1H alignment **0/1/2** · sweep quality **0/1/2** · rejection strength **0/0.75/1.5** · BOS quality **0/0.75/1.5** · entry quality **0/1** · R:R **0.5/0.75/1** · room to next level **0/0.5** · market conditions **0/0.25/0.5** → **execute at ≥ 7.0; counter-trend requires ≥ 8.5.**

### L. Example trades

> **All prices are hypothetical and illustrative only.** They are here to show the mechanics and the arithmetic, not to suggest a track record.

#### L1. Long win — cluster sweep, 2.7R available (score 9.75)

| Step | Value |
|---|---|
| 1H | Bullish: SH 104,800 > 103,900; SL 101,400 > 100,600 |
| avgBody (20) | 280 → buffer = 56 |
| Liquidity | Cluster of 2 swing lows at 101,950 / 101,910 → `L = 101,910` |
| Sweep | Candle low 101,720, close 102,180 → `SE = 101,720` |
| `BOS_LEVEL` | 102,540 |
| BOS candle | Closes 102,610, body 430 = 1.54 × avgBody ✔ |
| Entry | Limit 102,560 (filled on the pullback) |
| `SL` | 101,720 − 56 = 101,660 → `R = 900` |
| R:R | Nearest opposing liquidity 105,000 → `(105,000 − 102,560)/900 = 2.71R` ✔ |
| Sizing | Equity $1,200, risk 0.5% = $6 → size = 6/900 = 0.00667 BTC ≈ $683 notional |
| TP1 | 103,460 → 40% off (**+1R**) |
| TP2 | 104,360 → 30% off (**+2R**) |
| Runner | Structural trail exits at 106,100 → **+3.93R** on the last 30% |
| Result | `0.4×1 + 0.3×2 + 0.3×3.93 = +2.18R` gross ≈ **+1.95R net** after fees |

#### L2. Long win — single-swing sweep, clean displacement (score 8.75)

| Step | Value |
|---|---|
| 1H | Bullish |
| avgBody | 300 → buffer 60 |
| Liquidity | Single swing low 96,400 |
| Sweep | low 96,180, close 96,760 → `SE = 96,180` |
| `BOS_LEVEL` | 97,050; BOS candle closes 97,320, body 560 = 1.87 × avgBody |
| Entry | 97,070 → `SL = 96,120` → `R = 950` |
| R:R | Nearest opposing 99,500 → `2,430/950 = 2.56R` ✔ |
| Exits | TP1 98,020 (40%, +1R) · TP2 98,970 (30%, +2R) · runner trail exit 100,300 (+3.40R) |
| Result | `0.4 + 0.6 + 1.02 = +2.02R` gross ≈ **+1.8R net** |

#### L3. Long win — compression-break expansion day (score 9.75)

| Step | Value |
|---|---|
| 1H | Bullish; price 112,000 |
| avgBody | 420 → buffer 84 |
| Liquidity | Compression low touched 3× at 110,830 / 110,800 / 110,810 → `L = 110,800` |
| Sweep | low 110,600, close 111,050 → `SE = 110,600`; `SL = 110,510` |
| BOS | `BOS_LEVEL` 111,600; closes 111,900, body 850 = 2.0 × avgBody |
| Entry | 111,620 → `R = 1,110` |
| R:R | Nearest opposing 114,500 → `2,880/1,110 = 2.59R` ✔ |
| Exits | TP1 112,730 (40%) · TP2 113,840 (30%) · runner exits 116,600 (+4.49R) |
| Result | `0.4 + 0.6 + 1.35 = +2.35R` gross ≈ **+2.1R net** |

#### L4. Short win — equal-highs sweep (score 9.5)

| Step | Value |
|---|---|
| 1H | Bearish: LH 98,400 < 99,600; LL 95,200 < 96,300 |
| avgBody | 310 → buffer 62 |
| Liquidity | Equal highs 97,880 / 97,910 → `H = 97,910` |
| Sweep | high 98,120, close 97,640 → `SE = 98,120`; `SL = 98,180` |
| BOS | `BOS_LEVEL` 97,300; closes 97,050, body 590 |
| Entry | 97,280 → `R = 900` |
| R:R | Nearest opposing 95,400 → `1,880/900 = 2.09R` ✔ |
| Exits | TP1 96,380 (40%) · TP2 95,480 (30%) · runner exits 94,300 (+3.31R) |
| Result | `0.4 + 0.6 + 0.99 = +1.99R` gross ≈ **+1.8R net** |

#### L5. Short win — single swing high (score 8.75)

| Step | Value |
|---|---|
| 1H | Bearish; price 105,000 |
| avgBody | 380 → buffer 76 |
| Liquidity | Swing high 106,200 |
| Sweep | high 106,450, close 105,900 → `SE = 106,450`; `SL = 106,530` |
| BOS | `BOS_LEVEL` 105,400; closes 105,050, body 700 |
| Entry | 105,380 → `R = 1,150` |
| R:R | Nearest opposing 102,800 → `2,580/1,150 = 2.24R` ✔ |
| Exits | TP1 104,230 (40%) · TP2 103,080 (30%) · runner exits 101,900 (+3.03R) |
| Result | `0.4 + 0.6 + 0.91 = +1.91R` gross ≈ **+1.7R net** |

#### L6. Short win — range high swept 3 times (score 9.75)

| Step | Value |
|---|---|
| 1H | Bearish; price 92,000 |
| avgBody | 300 → buffer 60 |
| Liquidity | Range high 93,060 / 93,100 / 93,070 → `H = 93,100` |
| Sweep | high 93,260, close 92,880 → `SE = 93,260`; `SL = 93,320` |
| BOS | `BOS_LEVEL` 92,300; closes 92,000, body 700 |
| Entry | 92,280 → `R = 1,040` |
| R:R | Nearest opposing 89,500 → `2,780/1,040 = 2.67R` ✔ |
| Exits | TP1 91,240 (40%) · TP2 90,200 (30%) · runner exits 89,560 (+2.62R) |
| Result | `0.4 + 0.6 + 0.785 = +1.79R` gross ≈ **+1.6R net** |

#### L7. Loss — immediate structure failure (**−0.30R**)

| Step | Value |
|---|---|
| Setup | Valid long: sweep of 117,600 cluster, `SE = 117,200`, `SL = 117,130`, `BOS_LEVEL` 118,300, BOS closes 118,520, entry 118,320, `R = 1,190`, score 8.5 |
| What happened | Price reached 118,900 (+0.49R, TP1 not hit), then reversed |
| Trigger | Two consecutive 15m closes at 118,150 and 117,980 → both back below `BOS_LEVEL` |
| Exit | Market at 117,980 → loss `340 = 0.29R` |
| Result | **−0.30R** net. The structure-failure exit turned a would-be −1R into −0.3R |

#### L8. Loss — violent expansion candle through the stop (**−1.05R**)

| Step | Value |
|---|---|
| Setup | Valid long: `SE = 93,900`, buffer 64 → `SL = 93,840`; `BOS_LEVEL` 94,600, BOS closes 94,900; entry 94,620; `R = 780` |
| What happened | A single 15m candle with a range of 800 points drove straight through the stop on a macro headline |
| Exit | Stop-market triggered at 93,840, filled at 93,800 (slippage) |
| Result | Loss `820 = 1.05R`. Stops get slipped on spasms; this is the priced-in tail. The safety engine then halts new entries for 4 candles |

#### L9. Loss — TP1 hit, then full reversal on the rest (**−0.20R**)

| Step | Value |
|---|---|
| Setup | Valid short: `SE = 107,800`, buffer 70 → `SL = 107,870`; `BOS_LEVEL` 107,200; entry 107,180; `R = 690` |
| TP1 | 106,490 reached → 40% closed at **+1R** |
| What happened | A single large candle reversed straight up and closed above `SL` (no 2-close structure trigger, so the stop is what fired) |
| Exit | Stop at 107,870 |
| Result | `0.4×1 + 0.6×(−1.0) = −0.20R` net |
| Lesson | This is exactly the scenario that would be avoided by moving to breakeven after TP1 — and exactly why we don't: the same rule would have cut the L1/L2/L3/L5 runners short. Partial + full stop is the better trade-off |

#### L10. No trade — R:R rejection (score 7.75, blocked)

| Step | Value |
|---|---|
| Everything else | Textbook: 1H bullish, cluster swept at 101,910, BOS closes above 101,000... |
| Numbers | entry 101,000, `SL = 100,200` → `R = 800` |
| Nearest opposing | 102,200 → `reward = 1,200 = 1.5R` ❌ |
| Decision | **No trade.** Reward is insufficient. Price did reach 103,000 twenty minutes later — irrelevant: taking 1.5R setups makes the whole system negative after fees. The rule is the edge |

#### L11. No trade — compression + chop + wide spread

| Observation | Value | Rule |
|---|---|---|
| 20-candle range | 0.42% of price | compression (< 0.5%) |
| False breakouts in 20 candles | 3 | chop → stand down 8 candles |
| 1H | Neutral, price in the middle third | no-trade zone |
| Spread | 0.09% of mid during a data release | spread flag |
| Score | 5.5 (irrelevant — blocked by hard flags) | — |
| Decision | **No trade** until the compression resolves with a cluster sweep + BOS |

#### L12. No trade — already extended

| Observation | Value |
|---|---|
| Move | 5 consecutive bullish 15m candles with no pullback |
| Distance from last swing low | 4.2% (≈ 4.6 × avgBody away from the last swing extreme) |
| Rule | "Extended move" (§8.5): entry > 3 × avgBody from the last swing extreme |
| Decision | **No trade.** Any entry here has a stop that is either too wide or instantly hit; the move already happened |

### M. Complete decision tree

```
1.  New 15m candle closed?  ── no ─▶ wait
2.  Recompute 15m swings, avgBody, 1H swings (closed candles only)
3.  Position open?  ── yes ─▶ run Trade Manager (SL/TP/trail/structure/stall), then stop
4.  Safety state OK? (kill switch, daily loss, streak, trade count, staleness, spread)
        ── no ─▶ HOLD, log reason, stop
5.  Any §8 no-trade flag?  ── yes ─▶ HOLD, log the flag, stop
6.  Determine 1H bias (Bullish / Bearish / Neutral+position-in-range)
7.  For the allowed direction, find liquidity levels (swing + clusters)
8.  Valid sweep of a level in the last 3 candles?  ── no ─▶ HOLD
9.  Sweep invalidated (close beyond SE)?  ── yes ─▶ discard, HOLD
10. Within 6 candles of SE did a displacement candle close beyond BOS_LEVEL?
        ── no ─▶ setup expires in 6 candles, HOLD
11. Compute entry = BOS_LEVEL ± 2bps, SL = SE ∓ BUFFER, R = |entry − SL|
12. R ≤ 1.2% of price?  ── no ─▶ HOLD (stop too wide)
13. Find NEAREST_OPP / NEXT_OPP; rr ≥ 2.0 and room ≥ 2.5R?
        ── no ─▶ HOLD (insufficient reward)
14. Compute Trade Quality Score; ≥ 7.0 (or ≥ 8.5 counter-trend)?
        ── no ─▶ HOLD (low quality)
15. Size = (equity × 0.005) / R, cap notional at 3 × equity
16. Place limit at entry, valid 4 candles
17. Filled?  ── no ─▶ cancel, HOLD
18. Place stop-market at SL immediately
19. Manage: TP1 40% @ 1R; TP2 30% @ 2R; SL → +1R; structural trail on the last 30%
20. Record trade, score, exit reason, R multiple in the DB
```

### N. Pseudocode

Deliberately shaped like the existing strategy contract (`getName()`, `evaluate()`, `reset()`) so it can drop into `src/strategies/strategies/`, with the exchange/risk/execution concerns left to the other engines.

```js
// sweepShiftStrategy.js — Sweep & Shift (S&S-15)
// Pure rules. No network. No database. No knowledge of Delta's API.
// Receives closed candles, returns a plan or HOLD.

const SWING_LOOKBACK  = 2;      // fractal half-width
const AVG_BODY_N      = 20;
const DISPLACEMENT_X  = 1.2;    // body >= 1.2 * avgBody
const BUFFER_X        = 0.2;    // stop buffer = max(tick, 0.2 * avgBody)
const MIN_RR          = 2.0;
const MIN_ROOM_RR     = 2.5;    // NEXT_OPP must be at least this far
const BOS_WINDOW      = 6;      // candles after SE
const ENTRY_VALIDITY  = 4;      // candles the limit survives
const SCORE_MIN       = 7.0;
const SCORE_MIN_COUNTER = 8.5;
const MAX_R_PERCENT   = 1.2;    // |entry - SL| may not exceed 1.2% of price

// ---------------------------------------------------------------- swings ---
// confirmedSwings(candles, from) -> [{index, price}] using SWING_LOOKBACK on both sides.
function confirmedSwings(candles, from) {
  const out = [];
  for (let i = SWING_LOOKBACK; i + SWING_LOOKBACK < candles.length; i++) {
    const window = candles.slice(i - SWING_LOOKBACK, i + SWING_LOOKBACK + 1);
    if (candles[i].high === Math.max(...window.map(c => c.high))) out.push({ index: i, price: candles[i].high });
    if (candles[i].low  === Math.min(...window.map(c => c.low)))  out.push({ index: i, price: candles[i].low, });
  }
  // A swing at index i is only CONFIRMED from candle i + SWING_LOOKBACK onward.
  return out
    .filter(s => s.index + SWING_LOOKBACK <= from)
    .sort((a, b) => a.index - b.index);
}

function avgBody(candles) {
  const slice = candles.slice(-AVG_BODY_N);
  return slice.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / slice.length;
}

// ------------------------------------------------------------- structure ---
function swingHighs(candles, from) { return confirmedSwings(candles, from).filter(isHigh); }
function swingLows(candles, from)  { return confirmedSwings(candles, from).filter(isLow);  }

// Higher-high/higher-low test on the last two confirmed 1H swings.
function htfBias(hourlyCandles, from) {
  const highs = swingHighs(hourlyCandles, from);
  const lows  = swingLows(hourlyCandles, from);
  if (highs.length < 2 || lows.length < 2) return 'NONE';
  const [h0, h1] = highs.slice(-2).map(s => s.price);   // h0 older, h1 latest
  const [l0, l1] = lows.slice(-2).map(s => s.price);
  if (h1 > h0 && l1 > l0) return 'BULLISH';
  if (h1 < h0 && l1 < l0) return 'BEARISH';
  return 'NEUTRAL';
}

// ±2 touches within 0.15% count as one strong level; returns the extreme price.
function liquidityLevels(swings, side, price) {
  const levels = [];
  for (const s of swings) {
    const match = levels.find(l => Math.abs(l.price - s.price) / price <= 0.0015);
    if (match) {
      match.touches += 1;
      match.price = s.price;                 // keep the most extreme
      match.strength = match.touches >= 2 ? 'CLUSTER' : 'SINGLE';
    } else {
      levels.push({ price: s.price, touches: 1, strength: 'SINGLE' });
    }
  }
  return levels.filter(l => side === 'LONG' ? l.price < price : l.price > price);
}

// Nearest / next opposing liquidity pool from 15m + 1H swings and range edges.
function opposingLevels(candles, hourlyCandles, side, price) {
  const pool = [
    ...swingHighs(candles, candles.length - 1).map(s => s.price),
    ...swingHighs(hourlyCandles, hourlyCandles.length - 1).map(s => s.price),
  ].filter(p => (side === 'LONG' ? p > price : p < price));

  pool.sort((a, b) => side === 'LONG' ? a - b : b - a);
  return { nearest: pool[0] ?? null, next: pool[1] ?? null };
}

// ----------------------------------------------------------------- sweep ---
function detectSweep(candles, level, side) {
  const recent = candles.slice(-3);
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (side === 'LONG') {
      if (c.low < level.price && c.close > level.price) return { se: c.low, index: c };
    } else {
      if (c.high > level.price && c.close < level.price) return { se: c.high, index: c };
    }
  }
  // two-candle variant: candle A pierces, candle B closes back
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1], b = recent[i];
    const body = avgBody(candles);
    if (side === 'LONG' && a.low < level.price && b.close > level.price &&
        a.close >= level.price - 0.25 * body) return { se: a.low, index: a };
    if (side === 'SHORT' && a.high > level.price && b.close < level.price &&
        a.close <= level.price + 0.25 * body) return { se: a.high, index: a };
  }
  return null;
}

// ------------------------------------------------------------------- BOS ---
function detectBOS(candles, bosLevel, seIndex, side, body) {
  const window = candles.slice(seIndex + 1, seIndex + 1 + BOS_WINDOW);
  for (const c of window) {
    const candleBody = Math.abs(c.close - c.open);
    if (side === 'LONG'  && c.close > bosLevel && candleBody >= DISPLACEMENT_X * body) return c;
    if (side === 'SHORT' && c.close < bosLevel && candleBody >= DISPLACEMENT_X * body) return c;
  }
  return null;
}

// ------------------------------------------------------- no-trade engine ---
function marketFlags(candles, ticker, htf) {
  const flags = [];
  const last20 = candles.slice(-20);
  const price  = candles[candles.length - 1].close;
  const range  = Math.max(...last20.map(c => c.high)) - Math.min(...last20.map(c => c.low));

  if (range / price < 0.005) flags.push('COMPRESSION');

  let falseBreaks = 0;
  for (let i = 10; i < candles.length; i++) {
    const priorHigh = Math.max(...candles.slice(i - 10, i).map(c => c.high));
    const priorLow  = Math.min(...candles.slice(i - 10, i).map(c => c.low));
    if (candles[i].high > priorHigh && candles[i].close < priorHigh) falseBreaks += 1;
    if (candles[i].low  < priorLow  && candles[i].close > priorLow)  falseBreaks += 1;
  }
  if (falseBreaks >= 3) flags.push('CHOP');

  if (ticker && ticker.bestBid && ticker.bestAsk) {
    const spread = (ticker.bestAsk - ticker.bestBid) / ((ticker.bestAsk + ticker.bestBid) / 2);
    if (spread > 0.0005) flags.push('WIDE_SPREAD');
  }

  const body = avgBody(candles);
  const lastRange = candles[candles.length - 1].high - candles[candles.length - 1].low;
  if (lastRange > 3 * body) flags.push('VOLATILITY_SPASM');

  if (htf === 'NEUTRAL') {
    const h1 = candles.slice(-20);
    const lo = Math.min(...h1.map(c => c.low)), hi = Math.max(...h1.map(c => c.high));
    const pos = (price - lo) / (hi - lo);
    if (pos > 0.33 && pos < 0.67) flags.push('RANGE_MIDDLE');
  }
  return flags;
}

function isExtended(candles, side, entryCandidate, body) {
  const swings = side === 'LONG' ? swingLows(candles, candles.length - 1)
                                 : swingHighs(candles, candles.length - 1);
  if (!swings.length) return true;
  const extreme = swings[swings.length - 1].price;
  if (Math.abs(entryCandidate - extreme) > 3 * body) return true;

  let streak = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const bullish = candles[i].close > candles[i].open;
    if ((side === 'LONG' && bullish) || (side === 'SHORT' && !bullish)) streak += 1;
    else break;
  }
  return streak >= 4;
}

// ----------------------------------------------------------- trade score ---
function scoreTrade(ctx) {
  let score = 0;
  score += ctx.htf === 'ALIGNED' ? 2 : ctx.htf === 'NEUTRAL' ? 1 : 0;
  score += ctx.sweepStrength === 'CLUSTER' ? 2 : 1;
  score += ctx.rejection === 'STRONG' ? 1.5 : ctx.rejection === 'NORMAL' ? 0.75 : 0;
  score += ctx.bos === 'STRONG' ? 1.5 : 0.75;
  score += 1;                                              // entry is always a filled retest
  score += ctx.rr >= 3 ? 1 : ctx.rr >= 2.5 ? 0.75 : 0.5;
  score += ctx.room ? 0.5 : 0;
  score += ctx.softFlag ? 0.25 : 0.5;
  return score;
}

// ------------------------------------------------------------ main engine ---
class SweepShiftStrategy {
  constructor(options = {}) {
    this.name = 'SweepShift-15';
    this.symbol = options.symbol;              // TRADING_SYMBOL from .env
    this.tickSize = options.tickSize;          // from Delta instruments API
    this.contractValue = options.contractValue;
    this.equity = options.equity;
    this.riskPercent = options.riskPercent ?? 0.005;
    this.pending = null;                       // { side, entry, sl, expiry, plan }
    this.position = null;                      // Trade Manager owns the live state
  }

  getName() { return this.name; }
  reset() { this.pending = null; this.position = null; }

  // candles15m / candles1h: closed candles only. ticker: { price, bestBid, bestAsk }.
  // daily: { tradesToday, consecutiveLosses, pnlToday, rToday, halted }
  evaluate({ candles15m, candles1h, ticker, daily }, state) {
    if (this.position) return this.managePosition(candles15m, ticker);

    const price = ticker?.price;
    if (!price) return hold('No price');

    // 1. safety and market gates
    if (daily?.halted) return hold('Daily risk limit reached');
    if (daily?.tradesToday >= 4) return hold('Max trades for today');
    if (daily?.consecutiveLosses >= 2) return hold('Two consecutive losses — done for the day');

    const htf = htfBias(candles1h, candles1h.length - 1);
    const flags = marketFlags(candles15m, ticker, htf);
    if (flags.length) return hold(`No-trade flags: ${flags.join(', ')}`);

    const body = avgBody(candles15m);
    const buffer = Math.max(this.tickSize, BUFFER_X * body);
    const lastIdx = candles15m.length - 1;

    // 2. one direction at a time, chosen by the 1H bias (neutral allows both)
    const sides = htf === 'BULLISH' ? ['LONG'] : htf === 'BEARISH' ? ['SHORT'] : ['LONG', 'SHORT'];

    for (const side of sides) {
      const swings = side === 'LONG' ? swingLows(candles15m, lastIdx)
                                     : swingHighs(candles15m, lastIdx);
      const levels = liquidityLevels(swings, side, price);

      for (const level of levels) {
        const sweep = detectSweep(candles15m, level, side);
        if (!sweep) continue;

        // invalidation: any close beyond the sweep extreme kills the sweep
        if (candles15m.slice(-3).some(c => side === 'LONG' ? c.close < sweep.se : c.close > sweep.se)) continue;

        const bosLevels = side === 'LONG' ? swingHighs(candles15m, lastIdx)
                                          : swingLows(candles15m, lastIdx);
        const bosLevel = bosLevels.filter(s => s.index <= sweep.index).pop();
        if (!bosLevel) continue;

        const bos = detectBOS(candles15m, bosLevel.price, sweep.index, side, body);
        if (!bos) continue;

        // 3. trade plan
        const entry = side === 'LONG' ? bosLevel.price * 1.0002 : bosLevel.price * 0.9998;
        const sl    = side === 'LONG' ? sweep.se - buffer : sweep.se + buffer;
        const risk  = Math.abs(entry - sl);

        if (risk / entry > MAX_R_PERCENT / 100) continue;          // stop too wide
        if (isExtended(candles15m, side, entry, body)) continue;    // already ran

        const opp = opposingLevels(candles15m, candles1h, side, entry);
        if (!opp.nearest) continue;
        const reward = Math.abs(opp.nearest - entry);
        const rr = reward / risk;
        if (rr < MIN_RR) continue;                                  // insufficient reward
        const room = opp.next ? Math.abs(opp.next - entry) >= MIN_ROOM_RR * risk : false;

        const score = scoreTrade({
          htf: (side === 'LONG' && htf === 'BULLISH') || (side === 'SHORT' && htf === 'BEARISH')
                 ? 'ALIGNED' : htf === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
          sweepStrength: level.strength,
          rejection: classifyRejection(bos, body, side),
          bos: Math.abs(bos.close - bosLevel.price) / bosLevel.price >= 0.001 &&
               Math.abs(bos.close - bos.open) >= 1.5 * body ? 'STRONG' : 'NORMAL',
          rr, room, softFlag: false,
        });

        const counter = (side === 'LONG' && htf === 'BEARISH') || (side === 'SHORT' && htf === 'BULLISH');
        if (score < (counter ? SCORE_MIN_COUNTER : SCORE_MIN)) continue;

        const size = (this.equity * this.riskPercent) / risk;         // BTC amount
        const contracts = size / this.contractValue;

        this.pending = { side, entry, sl, expiry: ENTRY_VALIDITY, rr, score, se: sweep.se };
        return {
          action: side === 'LONG' ? 'BUY' : 'SELL',
          symbol: this.symbol,
          quantity: contracts,
          orderType: 'limit_order',
          price: round(entry),
          stopLoss: round(sl),
          takeProfit: [
            { price: round(side === 'LONG' ? entry + risk : entry - risk), percent: 40 },
            { price: round(side === 'LONG' ? entry + 2 * risk : entry - 2 * risk), percent: 30 },
          ],
          meta: { strategy: this.name, rr, score, sweepExtreme: sweep.se, bosLevel: bosLevel.price },
          reason: `Sweep+Shift ${side}: swept ${level.strength} liquidity at ${level.price}, BOS at ${bosLevel.price}, rr=${rr.toFixed(2)}, score=${score}`,
        };
      }
    }
    return hold('No valid setup');
  }

  // Called on every closed candle while a position is open — mirrors §7 exactly.
  managePosition(candles15m, ticker) {
    const p = this.position;
    const risk = Math.abs(p.entry - p.initialSl);
    const price = ticker.price;

    if (p.stage === 'OPEN' && reached(price, p.entry, risk, p.side, 2)) {
      p.stage = 'PARTIAL_2';
      p.sl = p.side === 'LONG' ? p.entry + risk : p.entry - risk;      // lock +1R, only now
    }
    if (p.stage === 'PARTIAL_2') {
      const swing = p.side === 'LONG'
        ? swingLows(candles15m, candles15m.length - 1).pop()
        : swingHighs(candles15m, candles15m.length - 1).pop();
      const buffer = Math.max(this.tickSize, BUFFER_X * avgBody(candles15m));
      if (swing) {
        const candidate = p.side === 'LONG' ? swing.price - buffer : swing.price + buffer;
        p.sl = p.side === 'LONG' ? Math.max(p.sl, candidate) : Math.min(p.sl, candidate);
      }
    }

    // structure failure: two consecutive closes back beyond BOS_LEVEL
    const last2 = candles15m.slice(-2);
    const failed = last2.length === 2 && last2.every(c =>
      p.side === 'LONG' ? c.close < p.bosLevel : c.close > p.bosLevel);
    if (failed) return exitAll(this, 'Structure failure');

    // stall: 8 candles going nowhere
    if (candles15m.length - p.openedAt >= 8 &&
        price > p.entry - 0.5 * risk && price < p.entry + 0.5 * risk) {
      return exitAll(this, 'Stall exit');
    }
    return hold('Position managed');
  }
}

const reached = (price, entry, risk, side, r) =>
  side === 'LONG' ? price >= entry + r * risk : price <= entry - r * risk;

function hold(reason) { return { action: 'HOLD', reason }; }
```

> Implementation notes: `classifyRejection`, `exitAll`, `round`, and the percentile partial fills are omitted for brevity but are straightforward. The Trade Manager (partial fills, stop updates, DB records) and the Risk Engine (daily counters, notional caps, duplicate protection) stay outside this class — the strategy returns *intent*, the engines enforce *reality*.

---

## Open critique of the brief (things I deliberately changed)

The brief was sound overall, but five points would have produced a worse system if followed literally:

1. **"Buy every breakout is wrong" is correct — but a sweep-reversal alone is also wrong.** Pure sweep-fade (buy the wick, no BOS) is a counter-trend knife catch that bleeds in strong trends. Requiring a **fed BOS + retest** is what turns the sweep from a guess into a confirmed structural shift. This is why the strategy is "Sweep **and** Shift" rather than "Sweep".
2. **Counter-trend trades are near-prohibited, not "allowed under strict conditions".** By gating them behind a score of ≥ 8.5 against a 1H trend, they are effectively unreachable unless every other factor including a cluster sweep and a 2.5R room is perfect. Being explicit beats a vague "strict conditions".
3. **"Do NOT move SL to breakeven too early" is right, but the usual alternative (leave the full stop) is worse than a hybrid.** The hybrid here — 40% off at 1R, no stop change until 2R, then lock 1R — keeps the tail intact while capping the realistic loss on the remainder at ~−0.3R…−0.5R.
4. **The 0–10 score is a ranking tool, not a filter to trust blindly.** It adds a filter that *looks* rigorous. It must be validated: run the backtest with and without it. If the no-filter version has the same expectancy, delete the score. Adding sophistication that isn't measured is exactly how a strategy gets curve-fitted.
5. **Missing from the brief: the structure-failure exit and the stall exit.** Without an intermediate "the breakout failed" exit, every loser is a full −1R. The two extra exits are the mechanical reason why "keep losing trades small" actually happens — they convert the common failure mode from −1R into −0.3R. This is the single highest-value addition to the original specification.

Also worth stating plainly: **the 2R minimum combined with a 4-candle limit-retest entry is a selectivity machine.** It will reject many setups that later work. That is the intended cost. If the backtest shows too few trades (< 150 over 2 years), the fix is *not* to lower MIN_RR — it is to add a second instrument, not to weaken the edge.
