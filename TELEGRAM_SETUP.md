# Telegram Bot Setup Guide

## Step 1: Create a Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Click `/start`
3. Click `/newbot`
4. BotFather asks for a name (e.g., `Trading Signals Bot`)
5. BotFather asks for a username (e.g., `trading_signals_bot`) — must end with `_bot` and be unique
6. **BotFather returns your bot token** (looks like: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
   - **SAVE THIS TOKEN** — you'll paste it in the Settings tab

## Step 2: Get Your Chat ID

### Option A: Direct Message (DM) to your bot
1. Search for your bot username in Telegram (e.g., `@trading_signals_bot`)
2. Click `/start`
3. Send a test message (e.g., `BUY RELIANCE 2500 SL:2450 T:2600`)
4. Go to `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Replace `<YOUR_BOT_TOKEN>` with your actual token
5. Look for `"chat":{"id": XXXXX}` — that's your **Chat ID**
   - For personal bot use, leave the Chat ID field blank in the dashboard (it will accept signals from any chat)

### Option B: Group or Channel
1. Create a Telegram Group or Channel
2. Add your bot to it
3. Send a test message in the group
4. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` and find the Chat ID
5. Negative IDs like `-123456789` or `-100123456789` indicate groups/channels — use these to filter signals to specific channels

## Step 3: Configure in Dashboard

1. Start the dashboard: `npm run dev`
2. Go to **Settings** tab
3. Paste:
   - **Kite API Key** (from your Kite account)
   - **Kite Access Token** (generated from your Kite login)
   - **Telegram Bot Token** (from BotFather)
4. Click **Save Credentials**

## Step 4: Create a Trading System

1. Go to **Systems** tab
2. Click **+ New System**
3. Fill in:
   - **System Name**: e.g., "Breakout Intraday"
   - **Telegram Chat ID**: Leave blank to accept all chats, or enter a specific chat ID to filter
   - **Exchange**: NSE, BSE, NFO, MCX
   - **Product**: CNC (Delivery), MIS (Intraday), NRML (F&O)
   - **Quantity**: Number of shares per order
   - **Auto-place**: Toggle ON to automatically place orders when signals arrive
4. Click **Save System**

## Step 5: Start Polling

1. Go to **Settings** tab
2. Click **Start Polling**
   - Indicator should turn green (● Live)
   - Server will poll Telegram every 2 seconds

## Step 6: Send Signals

Send messages to your bot in any of these formats:

```
BUY RELIANCE 2500 SL:2450 T:2600
SELL NIFTY23DEC @19500 SL:19600 TARGET:19300
buy tcs @3500 stop:3450 target:3600
BUY INFY 1800 SL 1760 TARGET 1870
```

**Supported keywords:**
- **Action**: BUY / SELL (case-insensitive)
- **Symbol**: First ALL-CAPS word (RELIANCE, TCS, INFY, NIFTY23DEC)
- **Price**: Optional `@` or standalone number
- **Stop Loss**: `SL:`, `stop:`, `stoploss:`
- **Target**: `T:`, `TGT:`, `TARGET:`

## Step 7: Watch Dashboard

1. Go to **Dashboard** tab
2. Signals appear in real-time as they arrive
3. If auto-place is enabled:
   - Entry order placed (LIMIT if price given, else MARKET)
   - Two-leg GTT created automatically (SL + Target = exit orders)
4. Both order and GTT status visible in the order table

## Troubleshooting

### Bot not responding
- Ensure bot token is saved in Settings
- Check that polling is started (green dot in Settings)
- Send a test message and watch the server logs: `npm run server`

### Signals not parsing
- Check message format matches one of the examples above
- Verify Chat ID matches (if you restricted it)
- Server logs show parsing errors

### Orders failing
- Verify Kite API Key and Access Token are correct
- Check market hours (Kite API may reject orders outside trading hours)
- Ensure sufficient funds in Kite account
- Check order limits (quantity, price range)

### GTT placement fails
- GTT requires trigger_values in ascending order (SL < Target)
- Some symbols may not support GTT — Kite API will reject with error
- Check Kite documentation for GTT eligibility per symbol

## Example: Full Signal Flow

```
User sends to bot:
  "BUY RELIANCE 2500 SL:2450 T:2600"

Dashboard:
  1. Signal received: BUY RELIANCE @2500
  2. Entry order placed: LIMIT order for 1 share @ ₹2500
  3. GTT created: 
     - If price hits ₹2450 → SELL 1 share (stop loss)
     - If price hits ₹2600 → SELL 1 share (target)

Result: 
  - Automatic entry at ₹2500
  - Auto-exit at either ₹2450 (loss) or ₹2600 (profit)
  - All order status visible in real-time on dashboard
```

## Security Notes

- **Never share your bot token** — it gives full control of your bot
- **API credentials** are stored locally in `server/config.json` — keep this file private and gitignored
- Telegram signals are only from bots/channels you explicitly send to
- Each system can filter by Chat ID to control which channels trigger orders

---

**Next**: Start sending signals and monitor the dashboard! 📊
