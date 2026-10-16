# Delta Trading Bot — Backend Foundation

A clean, beginner-friendly Node.js backend that talks to **Delta Exchange** and is ready to run
automated trading strategies later.

The project is deliberately simple: plain JavaScript, small files, one responsibility per file,
and no over-engineering. It is a **foundation** — it does not contain a real trading strategy yet.

---

## 1. Project purpose

Give you a reusable backend where you can plug in a strategy and have the boring parts already done:

- a Delta Exchange API client with signing, timeouts, retries and error translation
- market data (tickers, products, order book, candles)
- order and position lifecycle management
- a real-time WebSocket service for market/order/position updates
- a trading engine that connects market data → strategy → risk → order → position
- a configurable risk manager that runs **before** any order is sent
- MongoDB persistence for users, orders, positions, trades and strategies
- JWT authentication
- a **paper trading mode that is on by default**

---

## 2. Architecture

```
Market Data (REST / WebSocket)
        ↓
Strategy        (src/strategies)
        ↓
Trading Engine  (services/trading/tradingEngine.js)
        ↓
Risk Manager    (services/trading/riskManager.js)   ← must pass before anything else happens
        ↓
Order Manager   (services/trading/orderManager.js)
        ↓
Delta Exchange  (services/delta/*)
        ↓
Order / Position Updates (WebSocket)
        ↓
MongoDB         (src/models/*)
```

Layering rules used everywhere in this codebase:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Routes | `src/routes` | endpoints + middleware only |
| Controllers | `src/controllers` | read the HTTP request, call a service, send a response |
| Delta services | `src/services/delta` | everything that talks to Delta Exchange |
| Trading services | `src/services/trading` | application/business logic |
| Strategies | `src/strategies` | trading decisions only |
| Models | `src/models` | database access |

---

## 3. Folder structure

```
delta-trading-bot/
├── src/
│   ├── config/
│   │   ├── env.js                  # reads .env, single source of settings
│   │   └── deltaConfig.js          # Delta URLs, endpoints, WS channels
│   ├── controllers/                # thin HTTP layer
│   ├── routes/                     # endpoint definitions
│   ├── services/
│   │   ├── delta/                  # deltaClient, market, order, position services
│   │   ├── trading/                # engine, order/position/risk managers
│   │   └── websocket/              # real-time Delta socket service
│   ├── strategies/
│   │   ├── strategyManager.js      # registry + start/stop
│   │   └── strategies/
│   │       └── exampleStrategy.js  # demo strategy (replace with yours)
│   ├── models/                     # User, Order, Position, Trade, Strategy
│   ├── middlewares/                # auth + global error handling
│   ├── utils/                      # logger, errorHandler, helpers
│   ├── app.js                      # express app (no listening)
│   └── server.js                   # database + server bootstrap
├── tests/
├── .env                            # your secrets (git-ignored)
├── .env.example
└── package.json
```

---

## 4. Installation

```bash
# 1. install dependencies
npm install

# 2. create your environment file
cp .env.example .env     # Windows: copy .env.example .env

# 3. start in development (auto-restart)
npm run dev

# 4. start in production
npm start
```

Requires **Node.js 18 or newer**.

---

## 5. Environment variables

Everything is configured in `.env` (never commit it).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | runtime environment |
| `PORT` | `5000` | HTTP port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/delta_trading_bot` | database connection string |
| `JWT_SECRET` | — | secret used to sign login tokens |
| `JWT_EXPIRES_IN` | `7d` | token lifetime |
| `DELTA_API_KEY` | — | Delta Exchange API key |
| `DELTA_API_SECRET` | — | Delta Exchange API secret |
| `DELTA_BASE_URL` | `https://api.india.delta.exchange` | REST base URL |
| `DELTA_WS_URL` | `wss://socket.india.delta.exchange` | WebSocket URL |
| `DELTA_TIMEOUT_MS` | `10000` | request timeout |
| `DELTA_MAX_RETRIES` | `2` | retries for timeouts/5xx |
| `ENABLE_WEBSOCKET` | `true` | turn the real-time connection on/off |
| `TRADING_MODE` | `paper` | `paper` (simulated) or `live` (real money) |
| `ENABLE_LIVE_TRADING` | `false` | second safety switch for live orders |
| `RISK_TRADING_ENABLED` | `true` | global on/off switch for trading |
| `RISK_MAX_ORDER_QUANTITY` | `10` | max size of a single order |
| `RISK_MAX_POSITION_SIZE` | `100` | max size of one position |
| `RISK_MAX_DAILY_LOSS` | `500` | stop trading after this loss for the day |
| `RISK_MAX_OPEN_TRADES` | `5` | max simultaneous open orders |
| `RISK_MAX_PRICE_DEVIATION_PERCENT` | `5` | max distance from market price |
| `RISK_DUPLICATE_WINDOW_SECONDS` | `5` | duplicate-order detection window |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

Use `https://api.delta.exchange` / `wss://socket.delta.exchange` if your account is on Delta's
global entity instead of India.

---

## 6. MongoDB setup

Local MongoDB:

```bash
mongod --dbpath /path/to/data
```

Or use MongoDB Atlas and paste the connection string into `MONGODB_URI`:

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/delta_trading_bot
```

Collections created automatically: `users`, `orders`, `positions`, `trades`, `strategies`.

---

## 7. Delta Exchange API configuration

1. Log in to Delta Exchange → **API Keys** → create a key.
2. Enable **Read** and **Trading** permissions (no withdrawals).
3. Restrict the key by IP if you can.
4. Put the key and secret in `.env`:

```
DELTA_API_KEY=your_key
DELTA_API_SECRET=your_secret
```

How signing works (implemented once in `src/utils/helpers.js` and used only by
`src/services/delta/deltaClient.js`):

```
signature = HMAC_SHA256(secret, method + timestamp + path + query + body)
headers   = { api-key, timestamp, signature }
```

Public market-data endpoints are called without a signature; private ones (orders, positions,
wallet) require keys. Secrets are never logged and never returned by any API response.

---

## 8. Running locally

```bash
npm run dev
```

Then check:

```bash
curl http://localhost:5000/api/health
```

```json
{
  "success": true,
  "message": "Trading backend is running",
  "data": {
    "environment": "development",
    "tradingMode": "paper",
    "liveTradingEnabled": false,
    "deltaConfigured": true,
    "timestamp": "2026-01-01T00:00:00.000Z"
  }
}
```

### Endpoints

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | — | server health check |
| POST | `/api/auth/register` | — | create a user, returns a JWT |
| POST | `/api/auth/login` | — | log in, returns a JWT |
| GET | `/api/auth/me` | ✅ | current user |
| GET | `/api/market/ticker?symbol=BTCUSD` | — | latest ticker |
| GET | `/api/market/products` | — | all tradable instruments |
| POST | `/api/orders` | ✅ | place an order (paper or live, based on `TRADING_MODE`) |
| GET | `/api/orders` | ✅ | list orders |
| GET | `/api/orders/:id` | ✅ | one order |
| DELETE | `/api/orders/:id` | ✅ | cancel an order |
| GET | `/api/positions` | ✅ | list positions (`?sync=true` refreshes from Delta in live mode) |
| GET | `/api/positions/:symbol` | ✅ | one position |
| POST | `/api/positions/:symbol/close` | ✅ | close a position |
| GET | `/api/strategies` | ✅ | list registered strategies |
| POST | `/api/strategies/:name/start` | ✅ | start a strategy |
| POST | `/api/strategies/:name/stop` | ✅ | stop a strategy |

Example: place an order in paper mode

```bash
curl -X POST http://localhost:5000/api/orders \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSD","side":"buy","quantity":1,"price":100000}'
```

Example: start the example strategy

```bash
curl -X POST http://localhost:5000/api/strategies/ExampleStrategy/start \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSD","intervalMs":5000}'
```

Use `{"useWebSocket": true}` instead of `intervalMs` to drive the strategy from live socket data.

---

## 9. Paper / test trading

`TRADING_MODE=paper` (the default) means:

- orders are **never** sent to Delta Exchange
- every order is stored in MongoDB with `mode: "paper"` and status `filled`
- positions and trades are tracked locally so you can follow your strategy's behaviour
- the risk manager, trading engine and strategy system all behave exactly as in live mode

This is the sandbox. Run here until you fully trust your strategy.

---

## 10. Live trading safety

Live orders require **two** things at the same time:

```
TRADING_MODE=live
ENABLE_LIVE_TRADING=true
```

If either one is missing, every attempt is blocked and logged:

- `config.trading.isLive` is `true` only when both are set
- `riskManager` rejects the trade with a clear reason
- `orderManager` refuses to call Delta a second time with a 403 error
- the strategy/websocket/manual API all go through the same check

The client can never choose the mode through an API request — it always comes from `.env`.

Checklist before going live:

1. Test the full flow in paper mode for a while.
2. Set conservative `RISK_*` values.
3. Confirm `RISK_TRADING_ENABLED=true`.
4. Flip `TRADING_MODE=live` and `ENABLE_LIVE_TRADING=true`.
5. Watch the logs, `/api/orders` and `/api/positions`.

---

## 11. How to add a new strategy

1. Create `src/strategies/strategies/myStrategy.js`.
2. Export an object (or a class instance) with these methods:

```js
class MyStrategy {
  constructor() {
    this.name = 'MyStrategy';
    this.description = '...';
    this.symbol = 'BTCUSD';
  }

  getName() { return this.name; }

  reset() { /* clear any internal state */ }

  // marketData = { symbol, price, markPrice, bestBid, bestAsk, ... }
  // state      = { stats, lastSignal, ... }
  evaluate(marketData, state) {
    if (/* buy condition */) {
      return { action: 'BUY',  symbol: 'BTCUSD', quantity: 1, reason: 'why' };
    }
    if (/* sell condition */) {
      return { action: 'SELL', symbol: 'BTCUSD', quantity: 1, reason: 'why' };
    }
    return { action: 'HOLD' };
  }
}

module.exports = new MyStrategy();
```

3. Done. `strategyManager` loads every file inside `src/strategies/strategies` automatically —
you never touch the Delta API code.

4. Start it: `POST /api/strategies/MyStrategy/start`.

A strategy only decides **what it would like to do**. It never places orders itself — that is the
job of the trading engine, risk manager and order manager.

---

## 12. How order execution works

```
strategy.evaluate()          → BUY / SELL / HOLD
        ↓
tradingEngine                → validates the signal shape, adds symbol + strategy name
        ↓
orderManager.execute()       → collects data for the risk checks
        ↓
riskManager.validate()       → trading enabled? live allowed? size? position? daily loss?
                               open trades? duplicate? price deviation?
        ↓ (rejected → stops here, nothing is sent)
planned mode
   ├── paper → Order saved with mode "paper", status "filled"
   └── live  → Delta API POST /v2/orders → Order saved with the Delta order id
        ↓
positionManager.applyOrder() → opens / increases / reduces / closes the position
                               and writes a Trade document when a position closes
        ↓
WebSocket order & position updates keep MongoDB in sync
```

Every failure path is handled: risk rejection, invalid signal, Delta API error, timeout, rejected
order and duplicate order all produce a clear log line and a
`{ success: false, message: "..." }` response.

---

## Tests

```bash
npm test
```

Covered: health endpoint, authentication, risk manager rules, strategy signal generation,
order manager in paper mode, and error handling.

> The first test run downloads a temporary MongoDB binary (used by
> `mongodb-memory-server`), so it needs an internet connection once.

---

## Notes

- Never log or commit API keys, JWT secrets or passwords — the logger redacts them automatically.
- `RISK_*` values can be changed without touching code.
- The example strategy is a demo only. Replace it with `myStrategy.js`.
