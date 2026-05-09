# TWP — Development Status

> Last updated: 2026-05-09

---

## What is TWP

A personal trading dashboard that bridges Telegram signals to Zerodha Kite order execution. It monitors live market data, computes Ichimoku signals, and allows placing regular and GTT orders directly from the UI.

---

## Architecture

```
Telegram  ──polling──▶  telegramPoller  ──▶  signalParser  ──▶  SSE broadcast
                                                                        │
KiteTicker (WebSocket) ──ticks──▶  candleStore  ──candle close──▶  ichimoku  ──▶  SSE broadcast
                                                                        │
Browser  ──EventSource──────────────────────────────────────────────────┘
         (single persistent connection, no polling)
```

### Data flow key points
- **One SSE connection** per browser tab (`GET /api/stream`). All live data (ticks, signals, Ichimoku updates, order updates) arrive over this single stream.
- **No repeated API calls** for live data. After initial seed, Ichimoku state is pushed by the server on every candle close via `ichimoku_update` SSE event.
- **Zustand `ichiSignals` store** is the single source of truth — survives tab switches. HTTP fetch on first load writes here; SSE updates write here. Component remount never re-fetches.
- **Module-level `_initDone` flag** in `MarketWatch` prevents re-running subscription init when user navigates away and back.

---

## Server

### Entry point
`server/index.js`
- Starts Express on port 3001
- Auto-starts Telegram poller
- On boot: loads instrument cache + connects KiteTicker if Kite is authenticated
- **Clears entire watchlist on every boot** — each session starts fresh with no stale options, expired strikes, or previous-day futures

### Routes

| Route | File | Purpose |
|---|---|---|
| `GET /api/stream` | `index.js` | SSE stream — single connection for all live events |
| `POST /api/kite/auth/*` | `routes/kiteAuth.js` | Kite OAuth flow |
| `GET/POST /api/kite/*` | `routes/kite.js` | Order placement, GTT, order status |
| `GET/POST /api/instruments/*` | `routes/instruments.js` | Watchlist, search, subscribe/unsubscribe |
| `GET /api/ichimoku/:token` | `routes/ichimoku.js` | Initial Ichimoku seed for a token+interval |
| `GET /api/historical/*` | `routes/historical.js` | Historical OHLC candles |
| `GET/POST /api/telegram/*` | `routes/telegram.js` | Telegram poller control + signal history |
| `GET/POST /api/paper/*` | `routes/paperTrades.js` | Paper trading |
| `GET/POST /api/settings/*` | `routes/settings.js` | App settings |

### Key instrument endpoints

| Endpoint | What it does |
|---|---|
| `GET /instruments/search` | Search by symbol/name substring |
| `GET /instruments/watchlist` | Current watchlist |
| `POST /instruments/subscribe` | Add instrument + subscribe ticker |
| `POST /instruments/unsubscribe` | Remove instrument + unsubscribe ticker + drop candle buffer |
| `POST /instruments/subscribe-atm` | Subscribe ATM ±N strikes for NIFTY / BANKNIFTY / SENSEX |
| `POST /instruments/subscribe-movers` | Subscribe stocks within ±X%–Y% of today's open (both gainers and fallers) |
| `POST /instruments/subscribe-future` | Subscribe nearest-expiry future for a stock |
| `GET /instruments/futures-list` | All active NFO stock names |
| `POST /instruments/reload-cache` | Reload instrument cache on demand |

### Services

| Service | File | Purpose |
|---|---|---|
| `instrumentCache` | `services/instrumentCache.js` | In-memory cache of all Kite instruments (~100k rows). Loaded once after Kite auth. |
| `kiteTicker` | `services/kiteTicker.js` | WebSocket to Kite. Receives ticks, calls `candleStore.onTick`, broadcasts raw tick via SSE. |
| `candleStore` | `services/candleStore.js` | Per-token ring buffer of 120 candles per interval. Seeds from historical API on first access. Fires `onCandleClose` callback when a candle period closes. |
| `ichimoku` | `services/ichimoku.js` | Computes Ichimoku signals from a candle array. Called on every candle close by `kiteTicker`. |
| `historicalCache` | `services/historicalCache.js` | Fetches + deduplicates historical OHLC from Kite API. Used by `candleStore` for initial seed. |
| `kiteService` | `services/kiteService.js` | Axios wrappers for Kite REST API: `placeOrder`, `placeGTT`, `getOrders`, `getLTP`, `getQuote`. |
| `telegramPoller` | `services/telegramPoller.js` | Long-polls Telegram Bot API. Parses incoming messages via `signalParser`. |
| `signalParser` | `services/signalParser.js` | Extracts trade signals from Telegram message text. |
| `sseHub` | `sseHub.js` | Manages SSE client list. `broadcast(event, data)` fans out to all connected browsers. |
| `store` | `store.js` | Persists config + watchlist to `config.json`. |

### Candle store internals
- `Map<"token:interval", { candles[], currentSlot, currentCandle }>` — fixed 120-candle ring
- `Map<token, Set<interval>>` — reverse index for O(intervals) tick dispatch
- `onTick(token, price, ts, onCandleClose)` — updates current candle; on period boundary: pushes closed candle, evicts oldest if > 120, fires callback
- Concurrent seed requests for the same key are deduplicated via a `_seeding` Promise map

---

## Client

### State management
`client/src/store/appStore.js` — Zustand store

| Key | Type | Description |
|---|---|---|
| `watchlist` | `Instrument[]` | Subscribed instruments |
| `ticks` | `{ [token]: TickData }` | Latest tick per instrument |
| `tickerConnected` | `boolean` | WebSocket status |
| `ichiSignals` | `{ ["token:interval"]: Signals }` | Ichimoku signals — written by HTTP seed and SSE push |
| `signals` | `Signal[]` | Telegram trade signals (last 100) |
| `orders` | `Order[]` | Placed orders (last 100) |
| `paperTrades` | `Trade[]` | Paper trades (last 100) |

### SSE hook
`client/src/hooks/useSSE.js`
- Opens `EventSource` to `/api/stream` once on app mount
- Handles events: `tick_update`, `signal`, `order_update`, `ichimoku_update`, `ticker_status`, `heartbeat`
- `ichimoku_update` → calls `setIchiSignal` (writes to Zustand)

### Pages / components

| Component | Path | Description |
|---|---|---|
| `App` | `src/App.jsx` | Router — Dashboard, Market Watch, Settings |
| `Sidebar` | `Layout/Sidebar.jsx` | Nav sidebar, branding (TWP) |
| `MarketWatch` | `Market/MarketWatch.jsx` | Main market watch page |
| `Dashboard` | `Dashboard/Dashboard.jsx` | Signal feed + order management |
| `SettingsPanel` | `Settings/SettingsPanel.jsx` | Kite/Telegram config |

### MarketWatch internals
- **Tabs**: Nifty, Bank Nifty, Sensex, Stocks
- **Init (on first mount only — guarded by `_initDone` flag)**
  - Phase 1 (blocks loader): load watchlist + subscribe NIFTY underlying + NIFTY ATM ±2 strikes
  - Phase 2 (background, non-blocking): subscribe BANKNIFTY ATM ±5, SENSEX ATM ±5
  - Stocks tab: **empty on load** — user must trigger via Subscribe Movers
- **`_subscribedTabs` (module-level Set)**: prevents ATM re-subscribe when switching back to an index tab
- **`IndexStatusBar`**: shows Ichimoku bias (1m / 15m / 30m) for the active index. Reads from `ichiSignals` store — zero duplicate HTTP calls
- **`WatchRow`**: reads `ichiSignals` store directly. HTTP fetch only if store has no data for that `token:interval`
- **`StockFuturesPanel`**: min%/max% inputs + "↑ Subscribe Movers" button. Enters absolute % — both gainers and fallers in that range are subscribed

### ATM offsets
| Index | Offsets |
|---|---|
| NIFTY | ±2 strikes (step 50) |
| BANKNIFTY | ±5 strikes (step 100) |
| SENSEX | ±5 strikes (step 100) |

---

## Subscribe Movers logic

**Client**: user enters min% and max% (e.g. `6` and `8`)  
**Server** (`POST /instruments/subscribe-movers`):
1. Collects nearest-expiry future for every active NFO stock
2. Calls `GET /quote` in batches of 500 (Kite limit)
3. Computes `changePct = (last_price − ohlc.open) / ohlc.open × 100`
4. Keeps instruments where `|changePct|` is in `[lo, hi]` — covers **both gainers and fallers** automatically
5. Subscribes matched tokens via KiteTicker

---

## Startup behaviour

On every server boot (or Kite re-authentication):
1. Watchlist in `config.json` is **wiped completely**
2. Instrument cache loaded from Kite API
3. KiteTicker connects

On browser load:
1. `useSSE` opens SSE connection (stays open indefinitely)
2. `MarketWatch.init()` runs once — subscribes NIFTY then BANKNIFTY/SENSEX in background
3. Stocks tab stays empty until user uses the Movers filter

---

## Known gaps / potential next steps

- [ ] Stocks tab — display subscribed movers in a richer card view (current % change, signal)
- [ ] Notification when a Telegram signal arrives for a watched instrument
- [ ] Re-auth flow when Kite access token expires (currently requires manual settings update)
- [ ] Unit tests for `candleStore`, `ichimoku`, `signalParser`
- [ ] Mobile/responsive layout
