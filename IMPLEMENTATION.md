# TradeFlow — Implementation Reference

Trading dashboard that bridges Telegram signals to Kite (Zerodha) order execution, with live market data, backtesting, and Ichimoku analysis.

---

## Architecture

```
Telegram Group
     │  signal (4-line format)
     ▼
Telegram Poller (server)
     │  parses signal → broadcasts via SSE
     ▼
React Dashboard (client)
     │  displays signal, sends order to Kite
     ▼
Kite API (order / GTT)
```

**Stack:**
- Frontend: React + Vite, Zustand state, SSE for real-time push
- Backend: Express.js (Node), port 3001
- Market data: Kite WebSocket (`KiteTicker`) + REST historical API
- Process manager: pm2

---

## Project Structure

```
TelegramToKiteModal/
├── client/src/
│   ├── App.jsx                         # Root — page routing, SSE init, global state load
│   ├── api.js                          # Axios instance (baseURL /api)
│   ├── store/appStore.js               # Zustand store
│   ├── hooks/useSSE.js                 # SSE event listener hook
│   └── components/
│       ├── Layout/Sidebar.jsx          # Navigation + status indicators
│       ├── Dashboard/                  # Signal feed, order table, paper trading
│       ├── Market/MarketWatch.jsx      # Live watchlist + Ichimoku panel
│       ├── Backtest/BacktestPanel.jsx  # Signal backtesting UI
│       ├── Settings/SettingsPanel.jsx  # Kite auth, Telegram, trading defaults
│       └── Toast/Toast.jsx
│
└── server/
    ├── index.js                        # Express app, boot sequence
    ├── store.js                        # Config read/write (config.json)
    ├── sseHub.js                       # SSE client registry + broadcast
    ├── routes/
    │   ├── kiteAuth.js                 # OAuth login flow
    │   ├── kite.js                     # Order / GTT placement
    │   ├── telegram.js                 # Start/stop polling, debug
    │   ├── instruments.js              # Search, watchlist, subscribe-atm
    │   ├── historical.js               # Raw candle fetch
    │   ├── ichimoku.js                 # Ichimoku signals for any token
    │   ├── backtest.js                 # Signal simulation
    │   ├── paperTrades.js              # Paper trade CRUD
    │   └── settings.js                 # Trading defaults
    └── services/
        ├── telegramPoller.js           # Long-poll Telegram, parse → execute
        ├── signalParser.js             # 4-line signal format parser
        ├── kiteService.js              # Kite REST client (orders, LTP)
        ├── kiteTicker.js               # Kite WebSocket manager
        ├── instrumentCache.js          # 134K instrument CSV cache
        ├── historicalCache.js          # Candle fetch + 5-min TTL cache
        ├── ichimoku.js                 # Ichimoku calculator + signals
        └── backtestEngine.js           # Signal simulation engine
```

---

## Signal Flow

### Telegram → Order

1. Telegram group receives a 4-line message:
   ```
   NIFTY24550CE
   216
   200
   289
   ```
2. `telegramPoller` long-polls `getUpdates` every 2 seconds
3. `signalParser.parse()` extracts `{ symbol, action, entries[], sl, targets[] }`
4. Signal broadcast via SSE → dashboard shows it
5. **Live mode**: `kiteService.placeOrder()` per entry + GTT for SL/target
6. **Test mode**: paper trade stored in memory, fills simulated after 30 s

### Signal Format
- Line 1: tradingsymbol (e.g. `NIFTY24550CE`, `RELIANCE`)
- Line 2: entry price(s) — comma or dash separated (e.g. `216` or `216,205`)
- Line 3: stop loss
- Line 4: target(s) — optional, comma or dash separated

---

## Pages

### Dashboard
- System status cards (Kite auth, Telegram polling, Test mode)
- Live signal feed (SSE pushed)
- Order table with status
- Paper trading panel (balance, open/closed trades)

### Market Watch (`/market`)
- Search 134K instruments (NSE, NFO, BSE, BFO, MCX)
- Add to watchlist → subscribes KiteTicker WebSocket token
- Live price streaming (LTP, change%, OHLC, volume)
- Price flash animation on tick update
- **Quick Subscribe**: one-click ATM options
  - NIFTY ATM ±2 → subscribes 5 strikes × CE+PE (10 instruments)
  - SENSEX ATM ±5,0 → subscribes 3 strikes × CE+PE (6 instruments)
- **Ichimoku panel** (expandable per row): Chikou, Kijun, Cloud, Tenkan signals

### Backtest (`/backtest`)
- Search instrument, set entries/SL/targets/action/quantity
- Choose interval + last-N-candles or date range
- Simulates each entry price against historical candles
- Shows win/loss/P&L per entry with Ichimoku state at entry point

### Settings
- Kite API key/secret, OAuth login button
- Telegram bot token, start/stop polling
- Trading defaults: quantity, exchange, product type

---

## API Reference

### Kite Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/kite/auth/status` | Check if authenticated |
| GET | `/api/kite/auth/login` | Redirect to Kite login |
| GET | `/api/kite/auth/callback` | OAuth callback, stores access token |

### Orders
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/kite/order` | Place regular/SL order |
| POST | `/api/kite/gtt` | Place GTT (SL + target) |
| GET | `/api/kite/orders` | Fetch orders from Kite |

### Instruments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/instruments/search?q=NIFTY&exchange=NFO` | Search instruments (top 20) |
| GET | `/api/instruments/watchlist` | Get current watchlist |
| POST | `/api/instruments/subscribe` | Add to watchlist + subscribe ticker |
| POST | `/api/instruments/unsubscribe` | Remove from watchlist + unsubscribe |
| POST | `/api/instruments/subscribe-atm` | Subscribe near-ATM options (see below) |
| POST | `/api/instruments/reload-cache` | Re-download instrument CSV |
| GET | `/api/instruments/status` | Ticker + cache status |

#### subscribe-atm body
```json
{
  "index": "NIFTY",
  "offsets": [-2, -1, 0, 1, 2]
}
```
- `index`: `"NIFTY"` (step=50, exchange=NFO) or `"SENSEX"` (step=100, exchange=BFO)
- `offsets`: strike count offsets from ATM (e.g. `[-2,-1,0,1,2]` = 5 strikes)
- Gets live LTP from Kite, rounds to nearest strike, finds CE+PE, subscribes all

### Historical Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/historical/:token?interval=15minute&from=&to=&bars=` | Fetch candles |

### Ichimoku
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ichimoku/:token?interval=15minute&bars=100` | Ichimoku signals for token |

Response:
```json
{
  "close": 77300,
  "chikouValue": 77300,
  "price26ago": 75800,
  "chikouAbovePrice": true,
  "chikouSignal": "bullish",
  "kijun": 76100,
  "kijunSignal": "bullish",
  "tenkan": 76800,
  "tenkanSignal": "bullish",
  "cloudTop": 75200,
  "cloudBottom": 74100,
  "aboveCloud": true,
  "cloudSignal": "bullish",
  "cloudColor": "bullish",
  "tkCross": null,
  "overallSignal": "bullish",
  "candleCount": 100
}
```

### Backtest
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/backtest` | Simulate signal against historical candles |

```json
{
  "instrumentToken": 12345,
  "interval": "15minute",
  "bars": 200,
  "signal": {
    "entries": [216, 205],
    "sl": 200,
    "targets": [289, 310],
    "action": "BUY"
  },
  "quantity": 50
}
```

### Telegram
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/telegram/status` | Polling status |
| POST | `/api/telegram/start` | Start polling |
| POST | `/api/telegram/stop` | Stop polling |
| GET | `/api/telegram/debug` | Last 50 messages + parse status |

### SSE Stream
`GET /api/stream` — persistent connection, receives events:

| Event | Payload | Description |
|-------|---------|-------------|
| `status` | `{ connected, pollingStatus }` | Connection + polling state |
| `signal` | `{ id, ts, parsed, raw }` | New Telegram signal |
| `order_placed` | `{ orderId, symbol, action, price, status }` | Order result |
| `gtt_placed` | `{ gttId, symbol, sl, target, status }` | GTT result |
| `paper_trade` | trade object | Paper trade filled |
| `paper_balance` | balance object | Balance update |
| `tick` | `{ instrumentToken, lastPrice, change, ohlc, volume }` | Live price tick |
| `ticker_status` | `{ connected: bool }` | KiteTicker connect/disconnect |
| `heartbeat` | `{ ts }` | Keep-alive every 30 s |

---

## Services

### instrumentCache
- Downloads `https://api.kite.trade/instruments` CSV on boot (134K+ instruments)
- In-memory array, refreshed via `/reload-cache`
- `search(query, exchange)` — substring match, top 20
- `getOptionsByStrike(name, exchange, strikeValues)` — finds CE+PE for nearest expiry

### kiteTicker
- Wraps `KiteTicker` from `kiteconnect` npm
- `reconnect: false` — custom exponential backoff (1s → 2s → 4s → max 30s)
- Auth-failure detection (403) prevents reconnect spam on expired token
- On tick: broadcasts via SSE to all connected clients
- Persists subscribed tokens; re-subscribes on reconnect

### ichimoku
Settings: Tenkan=9, Kijun=26, Senkou B=52, displacement=26

| Line | Formula | Minimum candles |
|------|---------|-----------------|
| Tenkan-sen | (9H + 9L) / 2 | 9 |
| Kijun-sen | (26H + 26L) / 2 | 26 |
| Senkou Span A | (Tenkan + Kijun) / 2, +26 ahead | 52 |
| Senkou Span B | (52H + 52L) / 2, +26 ahead | 78 |
| Chikou Span | Current close, −26 behind | 26 |

**Key signals:**
- `chikouSignal`: current close vs close 26 bars ago (momentum)
- `kijunSignal`: close above/below base line (equilibrium)
- `overallSignal`: bullish if 3+ of 4 factors agree

### historicalCache
- 5-minute in-memory TTL cache keyed by `token_interval_from_to`
- `fetchLastNCandles(token, interval, count)` — auto-calculates `from` with 2.5× buffer for weekends

### backtestEngine
1. Phase 1: scan candles for entry touch (`low ≤ entry ≤ high`)
2. Phase 2: from entry forward, check SL then target per candle
3. Returns per entry: `{ status, exitReason, pnl, pnlPct, candlesToExit, ichimokuAtEntry }`
4. Status: `NOT_HIT` | `WIN` | `LOSS` | `OPEN`

---

## State Management (Zustand)

```js
{
  // Connectivity
  kiteConnected: bool,
  pollingStatus: 'running' | 'stopped',
  tickerConnected: bool,
  testMode: bool,

  // Trading data
  signals: [],        // SSE-pushed signals
  orders: [],         // SSE-pushed orders

  // Paper trading
  paperTrades: [],
  paperBalance: {},

  // Market watch
  watchlist: [],      // persisted in config.json
  ticks: {},          // { [instrumentToken]: { lastPrice, change, ohlc, volume } }

  // Settings
  tradingDefaults: { quantity, exchange, product }
}
```

---

## Configuration

Stored in `server/config.json` (auto-created):

```json
{
  "kiteAccessToken": "...",
  "tradingDefaults": {
    "quantity": 1,
    "exchange": "NFO",
    "product": "MIS"
  },
  "watchlist": [
    {
      "instrumentToken": 12345,
      "tradingsymbol": "SENSEX2651477300CE",
      "exchange": "BFO",
      "name": "SENSEX",
      "strike": 77300,
      "instrumentType": "CE",
      "expiry": "2026-05-14",
      "lotSize": 10
    }
  ]
}
```

Environment variables (`server/.env`):
```
KITE_API_KEY=
KITE_API_SECRET=
TELEGRAM_BOT_TOKEN=
PORT=3001
```

---

## Running

```bash
# Install dependencies
cd server && npm install
cd client && npm install

# Development
cd server && node index.js        # or: pm2 start index.js --name tradeflow-server
cd client && npm run dev           # Vite dev server on :5173

# Kite OAuth (run once per day — access token expires at 6 AM)
# 1. Open Settings → click "Login with Kite"
# 2. Authorise on Zerodha
# 3. Redirected back → token stored in config.json
```

---

## Planned — Phase 2

- **Condition Engine** (`conditionEngine.js`): subscribe instruments, run Ichimoku/price conditions on each tick
- **Telegram Sender** (`telegramSender.js`): when condition matches, send 4-line signal to Telegram group → existing poller picks it up → executes order
- **Setups UI**: define and save named setups (instrument + condition rules + signal template)

The design routes all order signals through Telegram so other group members receive the signal simultaneously and the full audit trail is preserved in the group chat.
