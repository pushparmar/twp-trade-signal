# TWP — Trade Signal Dashboard

A personal trading dashboard that connects **Telegram signals** to **Zerodha Kite**, with real-time market watch, Ichimoku Cloud analysis, and multi-timeframe signal detection for indices and stocks.

---

## Features

- **Real-time Market Watch** — Live tick prices via Zerodha Kite WebSocket
- **INDEX Tab** — NIFTY · BANKNIFTY · SENSEX × 1m / 3m / 5m / 15m signal grid
- **Ichimoku Signals** — PUT BUY / CALL BUY detection based on Chikou, Kijun, Cloud and Tenkan
- **Options Tab** — NIFTY / BANKNIFTY / SENSEX options with auto-selected timeframe from Index signal
- **Stocks Tab** — Subscribe futures movers (±% from open), 1m / 5m / 15m condition view per stock
- **Telegram Integration** — Receive trade signals from a Telegram bot
- **Paper Trading** — Test signals without placing real orders
- **Kite Order Placement** — Place orders directly via Kite API

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + Zustand |
| Backend | Node.js + Express |
| Real-time | Kite WebSocket ticker + SSE (Server-Sent Events) |
| Ichimoku | Custom implementation (9/26/52/26 standard settings) |
| Deployment | Vercel (frontend) + Railway (backend) |

---

## Project Structure

```
twp-trade-signal/
├── client/                  # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── Market/      # MarketWatch — main trading dashboard
│   │   │   └── Layout/      # Sidebar, navigation
│   │   ├── store/           # Zustand global state
│   │   ├── hooks/           # useSSE — live tick subscription
│   │   └── api.js           # Axios instance
│   └── vercel.json          # Vercel SPA rewrite config
├── server/                  # Express backend
│   ├── routes/
│   │   ├── kiteAuth.js      # Kite OAuth login + callback
│   │   ├── instruments.js   # Subscribe/unsubscribe, movers, ATM options
│   │   ├── ichimoku.js      # Ichimoku signal API
│   │   ├── historical.js    # Candle history from Kite
│   │   ├── telegram.js      # Telegram signal webhook
│   │   └── paperTrades.js   # Paper trade management
│   ├── services/
│   │   ├── kiteTicker.js    # Kite WebSocket — live ticks
│   │   ├── candleStore.js   # Ring buffer — candle aggregation
│   │   ├── ichimoku.js      # Ichimoku calculator + getSignals()
│   │   ├── instrumentCache.js # 50k+ instrument lookup cache
│   │   └── kiteService.js   # Kite REST API wrapper
│   ├── store.js             # In-memory + persisted state
│   └── .env.example         # Required environment variables
└── railway.json             # Railway deployment config
```

---

## Local Development

### Prerequisites
- Node.js 18+
- Zerodha Kite account with API access ([create app](https://developers.kite.trade/))
- Telegram bot token (optional)

### Setup

**1. Clone the repo**
```bash
git clone https://github.com/pushparmar/twp-trade-signal.git
cd twp-trade-signal
```

**2. Configure the server**
```bash
cp server/.env.example server/.env
```
Edit `server/.env` and fill in your Kite API key, secret, and Telegram bot token.

**3. Install dependencies and run**
```bash
npm run dev
```
This starts both the server (`localhost:3001`) and the client (`localhost:5173`) together.

**4. Authenticate with Kite**

Open `http://localhost:5173` → click **Login with Kite** → complete OAuth → you're live.

> Access token refreshes every day — just click Login again each morning before market open.

---

## Deployment

### Backend → Railway

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select this repo
3. Add environment variables (Settings → Variables):

| Variable | Value |
|---|---|
| `KITE_API_KEY` | Your Kite app API key |
| `KITE_API_SECRET` | Your Kite app API secret |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `FRONTEND_URL` | Your Vercel frontend URL (add after step below) |
| `PORT` | `3001` |

4. Railway auto-deploys. Copy the generated URL e.g. `https://twp-xxx.railway.app`

5. **Update your Kite app redirect URL** at [developers.kite.trade](https://developers.kite.trade) to:
   ```
   https://twp-xxx.railway.app/api/kite/auth/callback
   ```

### Frontend → Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project → Import from GitHub**
2. Select this repo, set **Root Directory** to `client`
3. Add environment variable:

| Variable | Value |
|---|---|
| `VITE_API_URL` | Your Railway server URL e.g. `https://twp-xxx.railway.app` |

4. Deploy. Copy the Vercel URL e.g. `https://twp.vercel.app`

5. Go back to Railway → add `FRONTEND_URL = https://twp.vercel.app`

---

## Ichimoku Signal Logic

Signals are computed server-side on each `/api/ichimoku/:token` call using standard settings (9 / 26 / 52 / 26).

### PUT BUY
Triggers when **all** conditions are true at the latest candle:
- Close is **above Kijun** (Chikou above equilibrium)
- Kijun has been **flat** for the last 6 candles (`range/avg < 0.1%`)
- Previous candle was **at or above** the price from 26 bars ago
- Current candle just **closed below** the price from 26 bars ago

### CALL BUY
Triggers when **all** conditions are true:
- Close is **below Kijun**
- Kijun has been **flat** for the last 6 candles
- Previous candle was **at or below** the price from 26 bars ago
- Current candle just **closed above** the price from 26 bars ago

### Condition count (no signal yet)
Each cell shows `3↑ 1↓` — the number of bullish/bearish factors across Chikou · Kijun · Cloud · Tenkan — so you can see momentum building before a signal fires.

---

## Environment Variables Reference

| Variable | Where | Description |
|---|---|---|
| `KITE_API_KEY` | Server | Kite app API key |
| `KITE_API_SECRET` | Server | Kite app API secret |
| `KITE_ACCESS_TOKEN` | Server | Optional pre-set access token |
| `TELEGRAM_BOT_TOKEN` | Server | Telegram bot token |
| `FRONTEND_URL` | Server | Vercel URL for Kite auth redirect |
| `PORT` | Server | Server port (Railway sets automatically) |
| `VITE_API_URL` | Client | Railway server URL for production API calls |

---

## License

Private — personal use only.
