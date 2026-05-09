# Market Watch & Condition Engine — Architecture

## Overview

Add **live market data streaming** and an **automated signal engine** to the existing trading dashboard. The system watches Kite instruments in real-time via WebSocket, evaluates user-defined conditions, and when a condition fires, sends a signal to Telegram — which feeds back through the existing pipeline (Telegram Poller → Signal Parser → Kite Order / Paper Trade).

---

## Current System (what exists today)

```
Telegram Group
      │  (message posted by a human or external source)
      ▼
┌─────────────────────┐
│  Telegram Poller    │ polls every 2s via getUpdates
│  (telegramPoller.js)│
└────────┬────────────┘
         │ raw text
         ▼
┌─────────────────────┐
│  Signal Parser      │ fixed 4-line format → { symbol, entries, sl, targets }
│  (signalParser.js)  │
└────────┬────────────┘
         │ parsed signal
         ▼
┌─────────────────────┐       SSE          ┌─────────────────┐
│  Order Execution    │ ───────────────────►│  Web App (React)│
│  Kite API / Paper   │  signal, order,     │  Dashboard      │
│                     │  paper_trade events  │  Paper Trades   │
└─────────────────────┘                     └─────────────────┘
```

---

## What We're Adding

```
                          ┌──────────────────────────────────┐
                          │     Instrument Cache             │
                          │  (instrumentCache.js)            │
                          │                                  │
                          │  • Downloads Kite instrument CSV │
                          │    (~5MB) once on start / daily  │
                          │  • In-memory Map:                │
                          │    "NFO:NIFTY24550CE" → 12345678│
                          │  • Search by symbol substring    │
                          └──────────────┬───────────────────┘
                                         │ instrument_token
                                         ▼
┌───────────────────────────────────────────────────────────────────┐
│                        Kite WebSocket                             │
│                     (kiteTicker.js)                                │
│                                                                   │
│  • Connects to wss://ws.kite.trade                                │
│  • Uses existing API key + access token from store.js             │
│  • Subscribes instrument tokens in "quote" mode                   │
│  • Receives real-time ticks: LTP, OHLC, volume, change, OI       │
│  • Emits ticks to:                                                │
│      1. SSE broadcast ("tick" event) → frontend live prices       │
│      2. Condition Engine → evaluate setups                        │
│  • Dynamic subscribe/unsubscribe as watchlist or setups change    │
│  • Auto-reconnects on disconnect                                  │
│  • Only active during market hours (9:15–15:30 IST, Mon–Fri)     │
└───────────────┬──────────────────────────────────┬────────────────┘
                │                                  │
        SSE "tick" event                    tick callback
                │                                  │
                ▼                                  ▼
┌──────────────────────┐          ┌──────────────────────────────┐
│   Web App (React)    │          │  Condition Engine (Phase 2)  │
│                      │          │  (conditionEngine.js)        │
│  NEW: Market Watch   │          │                              │
│  page in sidebar     │          │  • Evaluates user setups     │
│                      │          │  • On match → Telegram send  │
│  • Instrument search │          │  • Marks setup as triggered  │
│    dropdown          │          │                              │
│  • Live LTP, OHLC,   │          │  (BUILD LATER — Phase 2)    │
│    volume, change%   │          └──────────────────────────────┘
│  • Add/remove from   │
│    watchlist          │
│  • Color-coded       │
│    green/red ticks   │
└──────────────────────┘
```

---

## Phase 1 — Live Market Watch (build now)

### Goal

A user can search for any Kite instrument, add it to a watchlist, and see live price data updating in real-time via WebSocket.

### Backend — New Files

#### 1. `server/services/instrumentCache.js`

**Purpose**: Download and cache Kite's full instrument list for symbol → token lookups.

**Behavior**:
- On server start (after Kite auth is confirmed), download CSV from `https://api.kite.trade/instruments`
- Parse CSV into an in-memory array of objects: `{ instrumentToken, tradingsymbol, name, exchange, segment, lotSize, tickSize, instrumentType, expiry }`
- Build a `Map<"EXCHANGE:TRADINGSYMBOL", instrumentToken>` for fast lookups
- Provide `search(query)` — partial match on tradingsymbol, returns top 20 results
- Provide `getToken(exchange, tradingsymbol)` — exact lookup
- Refresh daily at 8:00 AM IST (before market opens) or on-demand via API
- If Kite is not connected, return empty results (don't crash)

**Kite instruments CSV columns**:
```
instrument_token, exchange_token, tradingsymbol, name, last_price,
expiry, strike, tick_size, lot_size, instrument_type, segment, exchange
```

**Dependencies**: `csv-parse` (npm package for streaming CSV parsing)

---

#### 2. `server/services/kiteTicker.js`

**Purpose**: Manage a persistent WebSocket connection to Kite for live market data.

**Behavior**:
- Uses the `kiteconnect` npm package (`KiteTicker` class)
- Connects using `apiKey` and `accessToken` from `store.getConfig()`
- Maintains a `Set<instrumentToken>` of currently subscribed tokens
- Exposes:
  - `subscribe(tokens[])` — add tokens to subscription, set mode to "quote"
  - `unsubscribe(tokens[])` — remove tokens
  - `getSubscribed()` — return current subscription list
  - `isConnected()` — connection status
  - `connect()` / `disconnect()` — lifecycle
- On each tick, calls a registered callback (the route layer / SSE broadcaster)
- Auto-reconnects on WebSocket close/error with exponential backoff (1s, 2s, 4s, max 30s)
- Logs connection state changes: `[KiteTicker] Connected`, `[KiteTicker] Disconnected`, `[KiteTicker] Reconnecting...`

**Tick data received per instrument** (in "quote" mode):
```json
{
  "instrumentToken": 12345678,
  "lastPrice": 216.50,
  "ohlc": { "open": 210, "high": 220, "low": 205, "close": 214 },
  "volume": 12450,
  "change": 1.17,
  "lastTradeTime": "2024-01-15T10:30:00",
  "oi": 5000,
  "oiDayHigh": 6000,
  "oiDayLow": 4500
}
```

**Important considerations**:
- Kite WebSocket supports max ~3000 instrument tokens per connection
- Tokens must be subscribed AFTER connection is established (not before)
- Access token expires daily — when Kite re-auth happens, ticker must reconnect with new token
- Subscribe in "quote" mode (not "full") to reduce bandwidth; "full" adds market depth which we don't need

---

#### 3. `server/routes/instruments.js`

**Purpose**: REST API for instrument search and watchlist management.

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/instruments/search?q=NIFTY&exchange=NFO` | Search instruments by symbol substring. Returns `[{ instrumentToken, tradingsymbol, exchange, name, lotSize, expiry }]` (max 20 results) |
| `POST` | `/api/instruments/subscribe` | Body: `{ instrumentToken, exchange, tradingsymbol }` — Subscribe to live ticks |
| `POST` | `/api/instruments/unsubscribe` | Body: `{ instrumentToken }` — Unsubscribe from live ticks |
| `GET` | `/api/instruments/watchlist` | Returns current watchlist `[{ instrumentToken, tradingsymbol, exchange }]` |
| `GET` | `/api/instruments/status` | Returns `{ connected: bool, subscribedCount: number }` — ticker health |

---

#### 4. Changes to existing files

**`server/index.js`**:
- Import and mount `instrumentsRouter` at `/api/instruments`
- After Kite auth is confirmed on startup, trigger `instrumentCache.load()` and `kiteTicker.connect()`
- Register tick handler: on every tick from kiteTicker, call `broadcast('tick', tickData)`

**`server/sseHub.js`**:
- No changes needed — `broadcast('tick', data)` works with existing infrastructure
- Note: tick events fire rapidly (multiple per second). Frontend must handle high-frequency updates efficiently.

**`server/store.js`**:
- Add `watchlist` to persisted config (array of `{ instrumentToken, tradingsymbol, exchange }`)
- `getWatchlist()` / `setWatchlist(items)` functions
- On server restart, auto-subscribe watchlist tokens to KiteTicker

---

### Frontend — New Files

#### 5. `client/src/components/Market/MarketWatch.jsx`

**Purpose**: Full-page watchlist with live-updating prices.

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│  Market Watch                                           │
│                                                         │
│  ┌─────────────────────────────────────────┐            │
│  │  🔍 Search instrument...        [NFO ▾] │            │
│  │  ┌─────────────────────────────────┐    │            │
│  │  │ NIFTY24500CE    NFO   Lot: 25  │ +  │            │
│  │  │ NIFTY24550CE    NFO   Lot: 25  │ +  │            │
│  │  │ NIFTY24JUN25FUT NFO   Lot: 25  │ +  │            │
│  │  └─────────────────────────────────┘    │            │
│  └─────────────────────────────────────────┘            │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Symbol        │ LTP     │ Chg%   │ Open  │ High  ││
│  │                │         │        │       │ Low   ││
│  │────────────────┼─────────┼────────┼───────┼───────││
│  │ NIFTY24550CE   │ 216.50  │ +2.3%  │ 210   │ 220   ││
│  │                │  ▲ 4.50 │        │       │ 205   ││
│  │────────────────┼─────────┼────────┼───────┼───────││
│  │ BANKNIFTY25CE  │ 450.00  │ -1.1%  │ 460   │ 465   ││
│  │                │  ▼ 5.00 │        │       │ 445   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Ticker: ● Connected   │   3 instruments subscribed     │
└─────────────────────────────────────────────────────────┘
```

**Behavior**:
- Search input with debounce (300ms) → calls `GET /api/instruments/search`
- Dropdown shows matches → click "+" to add to watchlist
- Watchlist table updates live from SSE `tick` events
- LTP flashes green (price up) or red (price down) on each tick
- "×" button to remove from watchlist
- Exchange filter dropdown (ALL / NSE / NFO / MCX / BSE)
- Shows connection status badge at bottom

**State management** (in `appStore.js`):
```js
watchlist: [],              // [{ instrumentToken, tradingsymbol, exchange, ... }]
ticks: {},                  // { [instrumentToken]: { ltp, open, high, low, close, volume, change, prevLtp } }
tickerConnected: false,     // WebSocket connection status

setWatchlist: (items) => ...,
addToWatchlist: (item) => ...,
removeFromWatchlist: (token) => ...,
updateTick: (tick) => ...,
setTickerConnected: (bool) => ...,
```

**Performance note**: Ticks can arrive 2-5 times per second per instrument. The store should only trigger re-renders for the specific instrument that changed. Use `instrumentToken` as key, and update only the relevant entry in the `ticks` map.

---

#### 6. Changes to existing frontend files

**`client/src/hooks/useSSE.js`**:
- Add listener for `tick` event → `updateTick(data)`
- Add listener for `ticker_status` event → `setTickerConnected(data.connected)`

**`client/src/store/appStore.js`**:
- Add watchlist and tick state/actions as described above

**`client/src/components/Layout/Sidebar.jsx`**:
- Add "Market" nav item between Dashboard and Settings

**`client/src/App.jsx`**:
- Add `MarketWatch` to `PAGES` map
- On boot, fetch `GET /api/instruments/watchlist` to restore watchlist
- On boot, fetch `GET /api/instruments/status` for ticker status

---

## Phase 2 — Condition Engine & Telegram Sender (build later)

### Goal

User defines "setups" (conditions) on the Market Watch page. When a condition matches against live tick data, the system sends a 4-line signal to the Telegram group. The existing Telegram Poller picks it up and executes the order.

### New files (Phase 2 only)

#### `server/services/conditionEngine.js`

**Purpose**: Evaluate user-defined conditions against every incoming tick.

**Setup definition**:
```json
{
  "id": "uuid",
  "symbol": "NIFTY24550CE",
  "exchange": "NFO",
  "instrumentToken": 12345678,
  "conditionType": "price_touch",
  "watchPrice": 216,
  "entries": [216, 205],
  "sl": 200,
  "targets": [289, 310],
  "active": true,
  "triggered": false,
  "createdAt": "2024-01-15T10:00:00Z"
}
```

**Condition types** (start simple, expand later):
| Type | Fires when |
|------|-----------|
| `price_touch` | LTP reaches or crosses `watchPrice` |
| `price_above` | LTP crosses above `watchPrice` |
| `price_below` | LTP crosses below `watchPrice` |

**Behavior**:
- On each tick, iterate active setups for that instrument token
- Compare LTP against condition
- On match:
  1. Mark setup as `triggered: true`
  2. Format the 4-line signal message
  3. Call `telegramSender.send(chatId, message)`
  4. Broadcast `setup_triggered` SSE event for UI notification
- Debounce: don't re-trigger the same setup within 60 seconds

#### `server/services/telegramSender.js`

**Purpose**: Send messages to a Telegram group via the bot.

**Behavior**:
- Uses same `TELEGRAM_BOT_TOKEN` from `.env`
- Needs a `TELEGRAM_CHAT_ID` in `.env` (the group/channel ID to send signals to)
- `send(chatId, text)` → `POST https://api.telegram.org/bot{TOKEN}/sendMessage`
- The message is formatted in the 4-line signal format so the poller can parse it

**Complete signal flow with condition engine**:
```
Live Tick (WebSocket) → Condition Engine → Match!
      → telegramSender.send() → Telegram Group
      → telegramPoller picks it up → signalParser → order execution
      → SSE → Web App shows order
```

---

## NPM Packages Required

| Package | Version | Purpose | Install in |
|---------|---------|---------|-----------|
| `kiteconnect` | `^5.0.0` | KiteTicker WebSocket client | `server/` |
| `csv-parse` | `^5.5.0` | Parse Kite instrument CSV | `server/` |

Install command:
```bash
cd server && npm install kiteconnect csv-parse
```

---

## SSE Event Reference (complete)

### Existing events
| Event | Payload | Source |
|-------|---------|--------|
| `signal` | `{ id, ts, chatId, raw, parsed }` | telegramPoller |
| `order_placed` | `{ id, ts, signalId, orderId, symbol, action, ... }` | telegramPoller |
| `order_update` | `{ orderId, ... }` | telegramPoller |
| `gtt_placed` | `{ id, signalId, orderId, gttId, ... }` | telegramPoller |
| `status` | `{ pollingStatus }` | telegramPoller |
| `paper_trade_pending` | `{ id, signalId, symbol, entryPrice, fillsAt }` | telegramPoller |
| `paper_trade` | `{ id, ts, signalId, symbol, entryPrice, ... }` | telegramPoller |
| `paper_trade_update` | `{ id, ... }` | paperTrades route |
| `paper_trades_cleared` | `{}` | paperTrades route |
| `test_mode` | `{ testMode }` | paperTrades route |
| `paper_balance` | `{ initial, available, invested, realizedPnl }` | paperTrades route |
| `heartbeat` | `{ ts }` | index.js |

### New events (Phase 1)
| Event | Payload | Source |
|-------|---------|--------|
| `tick` | `{ instrumentToken, tradingsymbol, lastPrice, ohlc, volume, change }` | kiteTicker |
| `ticker_status` | `{ connected: bool }` | kiteTicker |

### New events (Phase 2)
| Event | Payload | Source |
|-------|---------|--------|
| `setup_triggered` | `{ setupId, symbol, conditionType, ltp, message }` | conditionEngine |

---

## File Tree After Phase 1

```
server/
├── index.js                     ← mount /api/instruments, init ticker
├── sseHub.js                    ← no changes
├── store.js                     ← add watchlist persistence
├── config.json                  ← watchlist saved here
├── .env                         ← existing (KITE_API_KEY, etc.)
├── routes/
│   ├── instruments.js           ← NEW: search, subscribe, watchlist
│   ├── kite.js
│   ├── kiteAuth.js
│   ├── telegram.js
│   ├── paperTrades.js
│   └── settings.js
└── services/
    ├── instrumentCache.js       ← NEW: download + cache instrument CSV
    ├── kiteTicker.js            ← NEW: WebSocket connection manager
    ├── kiteService.js
    ├── signalParser.js
    └── telegramPoller.js

client/src/
├── App.jsx                      ← add Market page
├── App.css                      ← add market watch styles
├── hooks/
│   └── useSSE.js                ← add tick + ticker_status listeners
├── store/
│   └── appStore.js              ← add watchlist, ticks, ticker state
└── components/
    ├── Dashboard/
    │   ├── Dashboard.jsx
    │   ├── OrderTable.jsx
    │   ├── PaperTradingPanel.jsx
    │   ├── SignalFeed.jsx
    │   └── SystemCard.jsx
    ├── Layout/
    │   └── Sidebar.jsx          ← add Market nav item
    ├── Market/
    │   └── MarketWatch.jsx      ← NEW: live watchlist UI
    ├── Settings/
    │   └── SettingsPanel.jsx
    └── Toast/
        └── Toast.jsx
```

---

## Implementation Order

### Phase 1 — Live Market Watch
1. `npm install kiteconnect csv-parse` in server/
2. `server/services/instrumentCache.js` — instrument CSV download + search
3. `server/services/kiteTicker.js` — WebSocket connection manager
4. `server/store.js` — add watchlist persistence
5. `server/routes/instruments.js` — REST API endpoints
6. `server/index.js` — wire everything, init on startup
7. `client/src/store/appStore.js` — add watchlist + tick state
8. `client/src/hooks/useSSE.js` — tick + ticker_status listeners
9. `client/src/components/Market/MarketWatch.jsx` — UI
10. `client/src/components/Layout/Sidebar.jsx` — add Market nav
11. `client/src/App.jsx` — register Market page

### Phase 2 — Condition Engine (later)
12. `server/services/telegramSender.js` — send messages to Telegram
13. `server/services/conditionEngine.js` — evaluate conditions on ticks
14. `server/routes/setups.js` — CRUD for setup definitions
15. Frontend setup management UI

---

## Key Decisions & Tradeoffs

| Decision | Reasoning |
|----------|-----------|
| **Same server** | Kite auth token is already here; no need for inter-service communication. Ticker runs in the same process as Express. |
| **WebSocket over polling** | Options prices move fast; 5s polling misses price touches. WebSocket gives every tick. |
| **"quote" mode, not "full"** | "full" includes 20-level market depth — unnecessary data. "quote" gives LTP + OHLC + volume + OI. |
| **Instrument CSV cached in memory** | ~5MB parsed into a Map. Fast lookups. Refreshed daily. Avoids per-request downloads. |
| **Watchlist persisted in config.json** | Same pattern as tradingDefaults. Auto-subscribes on server restart. |
| **Condition engine sends to Telegram (not direct order)** | Telegram acts as audit trail + broadcast to other users. Reuses existing parser + execution pipeline. No new order-placement code. |
| **SSE for ticks to frontend** | Already have SSE infrastructure. No need for a second WebSocket from frontend to backend. |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Kite access token expires daily | Listen for auth callback; when new token arrives, reconnect KiteTicker with fresh token |
| WebSocket disconnect during market hours | Exponential backoff reconnect (1s → 2s → 4s → max 30s). Log disconnections. |
| High tick frequency overwhelms SSE | Only broadcast ticks for subscribed instruments (watchlist). Frontend debounces UI updates. |
| Instrument CSV download fails | Retry 3 times with 5s delay. If still fails, serve empty search results. Log warning. |
| Too many instruments subscribed | Kite limit is ~3000 tokens. Warn user if watchlist exceeds 50 instruments. |
